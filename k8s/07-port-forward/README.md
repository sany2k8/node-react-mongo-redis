# Step 7 — Port Forwarding

> **Direct tunneling for local testing.**

## The idea

`kubectl port-forward` opens a tunnel from a local port, **through the
Kubernetes API server**, straight into a Pod. It is the one way into your
cluster that works identically on kind, Docker Desktop, EKS, GKE, and a
locked-down private cluster behind a bastion.

```
your Mac                          API server                    Pod
localhost:8080  ──HTTPS/SPDY──►  kube-apiserver  ──────────►  10.244.1.5:3000
                (authenticated,           (kubelet streams
                 encrypted)                the connection)
```

That path matters:

- It rides your **existing kubectl credentials** — no firewall change, no public
  IP, no Service needed at all.
- It is **encrypted end to end**.
- It works **even when the Pod is not Ready** — no Service, no endpoints, no
  readiness required. That makes it the correct tool for debugging a Pod that a
  Service refuses to route to.

Given [step 6](../06-service/README.md) established that NodePort can't reach
this kind-based cluster from macOS, port-forward isn't just convenient here —
it's the primary way in.

## The basics

```bash
NS=node-react-mongo-redis

# forward to a SERVICE (picks one healthy backing pod — no load balancing!)
kubectl port-forward -n $NS svc/app 8080:80

# in another terminal
curl -s localhost:8080/api/health
open http://localhost:8080
```

Ctrl-C ends the tunnel. Other target forms:

```bash
kubectl port-forward -n $NS deploy/app 8080:3000     # picks one pod from the deployment
kubectl port-forward -n $NS pod/<pod-name> 8080:3000 # one exact pod
kubectl port-forward -n $NS rs/<rs-name> 8080:3000
```

> **`svc/app 8080:80` still targets ONE Pod.** Port-forward resolves the Service
> to a single backing Pod and pins the tunnel to it. It does **not** round-robin.
> If you're load-testing or debugging "one replica misbehaves", port-forward will
> hide the problem — use the socat proxy from step 6 instead.

## Port syntax

| Form | Meaning |
| ---- | ------- |
| `8080:80` | local 8080 → remote 80 |
| `80` | same port both sides (needs sudo for <1024) |
| `:80` | **random free local port** → remote 80 |
| `8080:http` | local 8080 → the **named** port `http` |

```bash
# let kubectl pick the local port — great in scripts, never conflicts
kubectl port-forward -n $NS svc/app :80
# Forwarding from 127.0.0.1:54892 -> 3000
```

## Reach the databases directly with your normal tools

This is where port-forward earns its keep. Mongo and Redis are `ClusterIP` —
deliberately unreachable from outside. Tunnel in and use your local GUI/CLI:

```bash
# terminal 1
kubectl port-forward -n $NS svc/mongo 27017:27017

# terminal 2 — your local mongosh talks to in-cluster Mongo
mongosh mongodb://localhost:27017/labdb --eval 'db.items.find().pretty()'
```

```bash
# terminal 1
kubectl port-forward -n $NS svc/redis 6379:6379

# terminal 2
redis-cli -h localhost -p 6379 KEYS '*'
redis-cli -h localhost -p 6379 GET hit_counter
```

No Docker Compose, no exposing a database to the internet, no NodePort. After
step 8 adds authentication, you'll add `-u`/`-a` flags — the tunnel is unchanged.

> Don't have `mongosh`/`redis-cli` locally? Run them in-cluster instead:
> ```bash
> kubectl run mongosh --rm -it --restart=Never --image=mongo:7.0 -n $NS -- \
>   mongosh mongodb://mongo:27017/labdb --eval 'db.items.find()'
>
> kubectl run redis-cli --rm -it --restart=Never --image=redis:7-alpine -n $NS -- \
>   redis-cli -h redis GET hit_counter
> ```

## Background it, then clean it up

```bash
kubectl port-forward -n $NS svc/app 8080:80 > /tmp/pf.log 2>&1 &
PF_PID=$!

curl -s localhost:8080/api/health

kill $PF_PID
```

Stray port-forwards are a classic annoyance — "address already in use" from a
tunnel you forgot three days ago:

```bash
# find and kill every stray forward
pgrep -fl "kubectl port-forward"
pkill -f "kubectl port-forward"

# what's holding a port hostage?
lsof -iTCP:8080 -sTCP:LISTEN
```

## Bind to all interfaces (careful)

By default kubectl binds **127.0.0.1 only**. To let another machine (or a
container) reach your tunnel:

```bash
kubectl port-forward --address 0.0.0.0 -n $NS svc/app 8080:80
```

That exposes your cluster to your whole LAN with no authentication in front of
it. Fine on a laptop for a demo; never in an office or a coffee shop.

## Gotchas

| Symptom | Cause |
| ------- | ----- |
| Tunnel dies on Pod restart | It's pinned to one Pod. `deploy/`/`svc/` re-resolve **only on reconnect**, not automatically. Re-run it. |
| `unable to listen on port` | Something local already has it. `lsof -iTCP:8080 -sTCP:LISTEN` |
| Works then hangs after idle | Long-lived SPDY streams get reaped by proxies/VPNs. Re-run; consider a retry loop. |
| Traffic all hits one Pod | Correct behavior — see the warning above. |
| `error: Pod not running` | Port-forward needs `Running` (not necessarily Ready). Check `kubectl get pods`. |

For a self-healing tunnel:

```bash
while true; do kubectl port-forward -n $NS svc/app 8080:80; echo "reconnecting..."; sleep 1; done
```

## port-forward vs the alternatives

| Tool | Reaches | Load balances | Needs Ready pod | Survives restart |
| ---- | ------- | ------------- | --------------- | ---------------- |
| `port-forward` | any Pod/Service | ✗ | ✗ | ✗ |
| NodePort | via node IP | ✓ | ✓ | ✓ |
| socat proxy (step 6) | via node IP | ✓ | ✓ | ✓ |
| `kubectl proxy` | the **API**, not Pods | — | — | ✓ |
| `kubectl exec` | inside one container | ✗ | ✗ | ✗ |

`kubectl proxy` is the one people confuse with port-forward. It proxies the
**Kubernetes API** to localhost:8001, not your app. You can reach a Service
through it via the API's proxy subresource:

```bash
kubectl proxy --port=8001 &
curl -s "http://localhost:8001/api/v1/namespaces/$NS/services/app:80/proxy/api/health"
kill %1
```

Useful for scripting against the API; too awkward for daily app access.

---

**Prev:** [Step 6 — Service](../06-service/README.md) · **Next:** [Step 8 — ConfigMap & Secret](../08-configmap-secret/README.md)
