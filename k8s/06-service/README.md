# Step 6 — Service (ClusterIP, NodePort)

> **Exposing apps to internal or external traffic.**

## The idea

Pods are disposable and their IPs change constantly. A Service is the **stable
front door**: one name, one virtual IP, and automatic load balancing across
whatever Pods currently match its selector.

```
                              Service "app"   (ClusterIP 10.96.x.x, DNS: app)
                                    │
             ┌──────────────────────┼──────────────────────┐
             ▼                      ▼                      ▼
       Pod app-abc            Pod app-def            Pod app-ghi
       10.244.1.5             10.244.2.7             10.244.2.8
```

The Service does **not** hold that list itself. The endpoints controller watches
for Pods matching the selector and writes their IPs into an **EndpointSlice**;
`kube-proxy` on every node turns that into iptables/IPVS rules. The "virtual IP"
is not a process — it's a packet-rewriting rule. Nothing listens on it.

## Apply it

```bash
NS=node-react-mongo-redis
kubectl apply -f 06-service/
kubectl get svc -n $NS
```

```console
NAME           TYPE        CLUSTER-IP       PORT(S)
app            ClusterIP   10.96.148.22     80/TCP
app-headless   ClusterIP   None             3000/TCP
app-nodeport   NodePort    10.96.31.7       80:30300/TCP
mongo          ClusterIP   10.96.203.11     27017/TCP
redis          ClusterIP   10.96.77.4       6379/TCP
```

## The payoff — the stack finally works

```bash
kubectl exec deploy/app -n $NS -- \
  node -e "fetch('http://localhost:3000/api/network-info').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,1)))"
```

```jsonc
{
 "mongo_reachable": true,     // <- was ENOTFOUND for four straight steps
 "redis_reachable": true
}
```

**Nothing about the app or the Deployment changed.** `MONGO_HOST=mongo` was set
back in step 2. The only new thing is a Service *named* `mongo`, and now the
name resolves. That is the whole point of Services.

## Prove it end to end

First, from **inside** the cluster — this always works:

```bash
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl:latest -n $NS -- \
  curl -s http://app/api/health
# {"status":"ok"}
```

### ⚠️ NodePort is not reachable from your Mac — and here's exactly why

Docker Desktop's multi-node Kubernetes is **kind under the hood**. Check it:

```bash
kubectl get nodes -o wide
#   desktop-control-plane   172.18.0.5
#   desktop-worker          172.18.0.3
#   desktop-worker2         172.18.0.4

docker port desktop-worker          # (nothing)
docker port desktop-control-plane   # 6443/tcp -> 127.0.0.1:52800
```

Two facts combine against you:

1. The kind nodes are **Docker containers** on the `kind` bridge network
   (`172.18.0.0/16`), and only the API server's 6443 is published to the host.
   A NodePort opens 30300 *on the node* — i.e. inside a container nothing forwards to.
2. On **macOS**, Docker runs in a VM, so the host cannot route to
   `172.18.0.x` at all. (On Linux you could just `curl 172.18.0.3:30300`.)

So `curl localhost:30300` hangs, and so does `curl 172.18.0.3:30300`. The
Service is fine — prove it by curling the node IP *from inside* the cluster:

```bash
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl:latest -n $NS -- \
  curl -s http://172.18.0.3:30300/api/health
# {"status":"ok"}   <- NodePort works, you just can't reach the node from macOS
```

> **LoadBalancer doesn't save you either.** This cluster runs
> `cloud-provider-kind`, so a `type: LoadBalancer` Service *does* get an
> EXTERNAL-IP — but it's `172.18.0.7`, on the same unreachable bridge. Try it and
> watch it hang too.

### Your two options

**Option A — `kubectl port-forward` (step 7).** Works everywhere, needs nothing.
This is why the next step exists, and it's what you'll use day to day.

**Option B — a socat proxy on the `kind` network.** Bridges host → node IP, so
`localhost:30300` behaves like a real NodePort. Useful when you want the browser
to hit a stable URL:

```bash
docker run -d --name k8s-np-proxy --network kind -p 30300:30300 alpine/socat \
  tcp-listen:30300,fork,reuseaddr tcp-connect:172.18.0.3:30300

curl -s localhost:30300/api/health   # {"status":"ok"}
open http://localhost:30300          # the React UI

# when done
docker rm -f k8s-np-proxy
```

With the proxy up, the whole stack is reachable:

```bash
curl -s -X POST localhost:30300/api/items -H 'Content-Type: application/json' -d '{"name":"from-kubernetes"}'
curl -s localhost:30300/api/items
curl -s localhost:30300/api/items/cached   # {"source":"mongo",...} then {"source":"redis-cache",...}
curl -s localhost:30300/api/counter        # redis INCR: 1, 2, 3...
```

Watch the Service load-balance — each Pod reports its own hostname:

```bash
for i in $(seq 1 12); do
  curl -s localhost:30300/api/ | python3 -c 'import sys,json; print(json.load(sys.stdin)["hostname"])'
done | sort | uniq -c
```

```console
   4 app-5d8c77fb87-b6bzr
   5 app-5d8c77fb87-h2pw2
   3 app-5d8c77fb87-wnhzv     <- one Service, three Pods, roughly even
```

> **The real-world lesson:** NodePort's reachability depends entirely on whether
> you can route to your nodes. On EKS/GKE you'd use a LoadBalancer or Ingress and
> never think about this. On local kind, port-forward is the honest answer.

## DNS: what name resolves to what

Every Service gets records in cluster DNS (CoreDNS):

| Name | Resolves from |
| ---- | ------------- |
| `mongo` | same namespace only |
| `mongo.node-react-mongo-redis` | anywhere in the cluster |
| `mongo.node-react-mongo-redis.svc` | anywhere |
| `mongo.node-react-mongo-redis.svc.cluster.local` | the actual FQDN |

The short name works because of the `search` list in the Pod's resolv.conf:

```bash
kubectl exec deploy/app -n $NS -- cat /etc/resolv.conf
```

```
nameserver 10.96.0.10
search node-react-mongo-redis.svc.cluster.local svc.cluster.local cluster.local
options ndots:5
```

> **`ndots:5` is a real performance trap.** Any name with fewer than 5 dots is
> tried against every `search` entry *first*. Looking up `mongo` costs up to 4
> failed queries. Looking up an external `api.stripe.com` (2 dots) costs 3 failed
> lookups before the real one. A trailing dot — `api.stripe.com.` — skips the
> search list entirely.

## The four Service types

| Type | What it does | Reachable from |
| ---- | ------------ | -------------- |
| **ClusterIP** (default) | Virtual IP + DNS | inside the cluster only |
| **NodePort** | ClusterIP **plus** the same port on every node (30000–32767) | outside, via `<node-ip>:<port>` |
| **LoadBalancer** | NodePort **plus** asks the cloud for an external LB | the internet (cloud only) |
| **ExternalName** | A CNAME to an external host. No proxying, no selector. | — |

They nest: NodePort ⊃ ClusterIP, LoadBalancer ⊃ NodePort.

**Headless** (`clusterIP: None`) is the odd one out — no VIP at all. DNS returns
every Pod IP directly:

```bash
kubectl run dnsutils --rm -it --restart=Never --image=busybox:1.36 -n $NS -- \
  nslookup app-headless
# returns 3 A records — one per pod

kubectl run dnsutils --rm -it --restart=Never --image=busybox:1.36 -n $NS -- \
  nslookup app
# returns 1 A record — the stable virtual IP
```

## `port` vs `targetPort` vs `nodePort`

```yaml
ports:
  - port: 80          # the Service's own port      -> http://app:80
    targetPort: http  # the Pod's port, BY NAME     -> container's :3000
    nodePort: 30300   # the node's port (NodePort only)
```

Using a **named** `targetPort` is the better habit: change the container port in
the Deployment and every Service follows automatically.

## Debugging a Service that returns nothing

This is the #1 Kubernetes support question, and the answer is almost always the
selector. Work down this list:

```bash
# 1. Does the Service have ANY endpoints? Empty = selector matches no pods.
kubectl get endpointslices -n $NS -l kubernetes.io/service-name=app

# 2. Compare the Service's selector to the Pods' actual labels — character by character
kubectl get svc app -n $NS -o jsonpath='{.spec.selector}'; echo
kubectl get pods -n $NS --show-labels

# 3. Are the pods actually Ready? NOT-ready pods are pulled from endpoints.
kubectl get pods -n $NS -l component=app

# 4. Is targetPort right?
kubectl get svc app -n $NS -o jsonpath='{.spec.ports}'; echo

# 5. Test from inside the cluster
kubectl run tmp --rm -it --restart=Never --image=curlimages/curl:latest -n $NS -- \
  curl -s http://app/api/health
```

> **Point 3 is the one that surprises people:** a Service silently removes any
> Pod that isn't Ready from its endpoints. That's a feature — it's how rolling
> updates avoid sending traffic to a booting Pod — but it means **your readiness
> probe controls your load balancer.** Get it wrong (step 13) and a Service with
> healthy Pods serves nothing at all.

## Clean up

Leave it running — steps 7–13 build on it.

---

**Prev:** [Step 5 — Deployment](../05-deployment/README.md) · **Next:** [Step 7 — Port Forwarding](../07-port-forward/README.md)
