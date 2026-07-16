# Kubernetes, Step by Step

A hands-on Kubernetes course built on **this** project — your Express + React +
MongoDB + Redis stack, running from your own Docker Hub image
(`sany2k8/node-react-mongo-redis-app`).

Every manifest here was **applied to a real cluster and verified**. Every
`console` block is real output, including the failures — several sections exist
precisely because the first attempt was wrong.

---

## The 14 steps

| # | Step | Concept |
| - | ---- | ------- |
| 1 | [Namespace](01-namespace/README.md) | Isolated workspaces, ResourceQuota, LimitRange |
| 2 | [Pod](02-pod/README.md) | The smallest deployable unit; sidecars & initContainers |
| 3 | [Labels & Selectors](03-labels-selectors/README.md) | The glue binding everything together |
| 4 | [ReplicaSet](04-replicaset/README.md) | The reconciliation loop |
| 5 | [Deployment](05-deployment/README.md) | Declarative updates over ReplicaSets |
| 6 | [Service](06-service/README.md) | ClusterIP, NodePort, headless, DNS |
| 7 | [Port Forwarding](07-port-forward/README.md) | Tunneling for local testing |
| 8 | [ConfigMap & Secret](08-configmap-secret/README.md) | Config and credentials injection |
| 9 | [PersistentVolume & PVC](09-persistent-volume/README.md) | Durable state |
| 10 | [Jobs](10-jobs/README.md) | Migrations, seeds, CronJobs |
| 11 | [HPA](11-hpa/README.md) | Autoscaling (+ metrics-server) |
| 12 | [Rolling Updates & Rollbacks](12-rolling-update-rollback/README.md) | Zero-downtime deploys |
| 13 | [Probes](13-probes/README.md) | Liveness, readiness, startup |
| 14 | [Helm & Helmfile](14-helm/README.md) | Packaging it all up |

Steps build on each other — **do them in order.** The story is cumulative: step
2 leaves the app unable to reach Mongo, and it stays broken until step 6 fixes
it with one Service. Step 5 catches Kubernetes calling a Pod "Ready" when it
isn't; step 13 explains why and fixes it. Step 8 gives your database amnesia;
step 9 cures it.

---

## Prerequisites

| Tool | Check | Notes |
| ---- | ----- | ----- |
| A cluster | `kubectl get nodes` | Docker Desktop → Settings → Kubernetes |
| kubectl | `kubectl version --client` | |
| metrics-server | `kubectl top nodes` | **Not installed by default** — [step 11](11-hpa/README.md) has a kind-ready copy |
| helm + helmfile | `helm version` | Only for [step 14](14-helm/README.md): `brew install helm helmfile` |

Verified against **Kubernetes v1.36.1** on a 3-node Docker Desktop cluster
(`desktop-control-plane`, `desktop-worker`, `desktop-worker2`), macOS/arm64.

---

## Start here

```bash
cd k8s

# 1. Create the namespace, quota, and limit range
kubectl apply -f 01-namespace/namespace.yaml

# 2. Save yourself typing -n on every command
kubectl config set-context --current --namespace=node-react-mongo-redis

# 3. Work through the steps
open 01-namespace/README.md
```

Or jump to the finished product:

```bash
helm install nrmr ./14-helm/nrmr -f 14-helm/environments/prod.yaml \
  -n node-react-mongo-redis --wait
helm test nrmr -n node-react-mongo-redis --logs
```

---

## 🚨 Read this before step 6: NodePort doesn't work on your Mac

Docker Desktop's multi-node Kubernetes is **kind under the hood**. Its nodes are
Docker containers on the `kind` bridge (`172.18.0.0/16`), and only the API
server's port is published:

```console
$ docker port desktop-worker          # (nothing)
$ docker port desktop-control-plane   # 6443/tcp -> 127.0.0.1:52800
```

On macOS the host can't route to `172.18.0.x` at all, so `curl localhost:30300`
and `curl 172.18.0.3:30300` both hang. **The Services are fine** — you just
can't reach a node from macOS. `type: LoadBalancer` doesn't help either; it gets
an EXTERNAL-IP on the same unreachable bridge.

Two ways in:

```bash
# A. port-forward — always works, but pins to ONE pod (no load balancing)
kubectl port-forward -n node-react-mongo-redis svc/app 8080:80

# B. socat bridge — a real, load-balanced NodePort URL
docker run -d --name k8s-np-proxy --network kind -p 30300:30300 alpine/socat \
  tcp-listen:30300,fork,reuseaddr tcp-connect:172.18.0.3:30300
curl localhost:30300/api/health
```

Use **B** whenever you need to observe load balancing or a rolling update —
port-forward will hide both. [Step 6](06-service/README.md) explains why in full.

---

## What you're deploying

```
                      ┌──────────────────────────────┐
   localhost:30300 ──►│  Service app (NodePort)       │
   (via socat)        └───────────────┬───────────────┘
                                      │ load balances
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
        ┌──────────┐            ┌──────────┐            ┌──────────┐
        │ app pod  │            │ app pod  │            │ app pod  │   HPA: 2-8
        │ Express  │            │ Express  │            │ Express  │
        │ + React  │            │ + React  │            │ + React  │
        └────┬─────┘            └────┬─────┘            └────┬─────┘
             └───────────────────────┼───────────────────────┘
                        ┌────────────┴────────────┐
                        ▼                         ▼
                ┌───────────────┐         ┌───────────────┐
                │ Service mongo │         │ Service redis │   ClusterIP
                └───────┬───────┘         └───────┬───────┘
                        ▼                         ▼
                ┌───────────────┐         ┌───────────────┐
                │  mongo pod    │         │  redis pod    │
                │  + PVC 1Gi    │         │  + PVC 512Mi  │
                └───────────────┘         └───────────────┘
```

### Image tags

| Tag | Contents |
| --- | -------- |
| `:v1` | reports `"version": "v1"` at `/api/` |
| `:v2` | identical source, reports `"version": "v2"` |

Both were built from the same code with a different `APP_VERSION` build arg, so
[step 12](12-rolling-update-rollback/README.md)'s rolling update is *observable*
— you watch responses flip v1 → v2 in real time.

### Endpoints, and why they matter here

| Endpoint | Touches | Used for |
| -------- | ------- | -------- |
| `/api/health` | **nothing** | liveness & readiness probes ([step 13](13-probes/README.md)) |
| `/api/` | nothing | reports `version` + `hostname` — load balancing & rollouts |
| `/api/network-info` | Mongo, Redis | connectivity debugging |
| `/api/items` | **Mongo** (503 if down) | persistence ([step 9](09-persistent-volume/README.md)) |
| `/api/items/cached` | Redis → Mongo | cache behavior |
| `/api/counter` | **Redis** | `INCR` — proves AOF survived a restart |

That `/api/health` touches nothing is the point of step 13: **a liveness probe
that checks your database turns a database blip into an app outage.**

---

## The eight lessons this lab proves with real output

1. **A Pod is an island** — `getaddrinfo ENOTFOUND mongo` for four straight steps, fixed by one Service. ([2](02-pod/README.md), [6](06-service/README.md))
2. **A ReplicaSet never updates existing Pods** — `set image` on an RS leaves every Pod on the old image. That gap is what a Deployment fills. ([4](04-replicaset/README.md))
3. **"Ready" is a lie without a readiness probe** — `rollout status` says success while the app answers `ECONNREFUSED`. ([5](05-deployment/README.md), [13](13-probes/README.md))
4. **Env vars from a ConfigMap never update** — patch it, wait, and the env var is still stale while the mounted *file* changed. ([8](08-configmap-secret/README.md))
5. **`emptyDir` gives your database amnesia** — `docs=0` after a Pod restart; a PVC brings it back, counter resuming at 4 not 1. ([9](09-persistent-volume/README.md))
6. **`maxUnavailable: 0` means a broken deploy is a non-event** — a bad image tag stalls the rollout with **70/70 requests still served**. ([12](12-rolling-update-rollback/README.md))
7. **Liveness must never check a dependency** — same app, same Mongo outage: dep-checking Pod restarts 0→1→2, properly-probed Pods hold at 0. ([13](13-probes/README.md))
8. **Kubernetes does NOT auto-rollback** — `ProgressDeadlineExceeded` only *reports*. `--atomic` is how you get it. ([12](12-rolling-update-rollback/README.md), [14](14-helm/README.md))

---

## Cheat sheet

```bash
NS=node-react-mongo-redis     # zsh doesn't word-split; don't put "-n" in the var

kubectl get all -n $NS
kubectl get pods -n $NS -w
kubectl get pods -n $NS -o wide --show-labels

# the three you'll use constantly
kubectl describe pod <pod> -n $NS          # Events are at the bottom — read them first
kubectl logs <pod> -n $NS -f
kubectl logs <pod> -n $NS --previous       # the CRASHED instance — CrashLoopBackOff lifesaver

kubectl exec -it <pod> -n $NS -- sh
kubectl port-forward -n $NS svc/app 8080:80

kubectl get events -n $NS --sort-by=.lastTimestamp | tail -20
kubectl top pods -n $NS                    # needs metrics-server (step 11)
kubectl diff -f manifest.yaml              # best habit in this list — diff before apply

kubectl api-resources                      # what exists?
kubectl explain deployment.spec.strategy   # built-in docs for any field
```

The image is `node:22-slim` — **no curl**, but Node 22 has a global `fetch()`:

```bash
kubectl exec deploy/app -n $NS -- \
  node -e "fetch('http://localhost:3000/api/health').then(r=>r.text()).then(console.log)"
```

---

## Teardown

```bash
# steps 1-13
kubectl delete namespace node-react-mongo-redis

# step 14 leaves PVCs/Secrets behind on purpose (helm.sh/resource-policy: keep)
kubectl get pvc,secret -n node-react-mongo-redis

# extras
docker rm -f k8s-np-proxy
kubectl delete -f 11-hpa/metrics-server.yaml   # or keep it — `kubectl top` is useful
```

---

## Where to go next

Things this lab deliberately leaves out:

| Topic | Why it matters |
| ----- | -------------- |
| **StatefulSet** | The right way to run Mongo. [Step 9](09-persistent-volume/README.md) explains exactly why a Deployment+PVC isn't. |
| **Ingress / Gateway API** | One entry point, TLS, host/path routing — instead of a NodePort per service. |
| **RBAC & ServiceAccounts** | The other half of what namespaces are for. |
| **NetworkPolicy** | Namespaces do **not** isolate traffic. By default every Pod can reach every Pod. |
| **PodDisruptionBudget** | Protects availability during node drains — `maxUnavailable` only covers *your* rollouts. |
| **SecurityContext / Pod Security** | `runAsNonRoot`, read-only rootfs, dropped capabilities. |
| **GitOps** (Argo CD / Flux) | Step 12 showed `rollout undo` gets silently reverted by the next `apply`. Git as the source of truth is the fix. |
| **Observability** | Prometheus, Grafana, OpenTelemetry. |
