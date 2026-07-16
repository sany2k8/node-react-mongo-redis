# Step 2 — Pod

> **The smallest deployable unit.**

## The idea

Kubernetes does not run containers. It runs **Pods**, which *contain*
containers. A Pod is a group of containers that share:

- **A network namespace** — one IP, one port space. Containers in a Pod reach
  each other on `localhost`. Two containers in the same Pod **cannot** both bind
  port 3000.
- **Volumes** — the same mounted directories.
- **A lifecycle** — they are scheduled together onto one node, and they die together.

A Pod is **mortal and never resurrected**. Delete it and it is gone; nothing
recreates it. That is the entire reason ReplicaSets (step 4) and Deployments
(step 5) exist. You will almost never write a bare Pod in production — but you
need to understand it, because everything above it produces Pods.

## Apply it

```bash
kubectl apply -f 02-pod/app-pod.yaml
kubectl get pods -n node-react-mongo-redis -w    # Ctrl-C when Running
```

## Look inside

```bash
# The single most useful debugging command in Kubernetes. Read the Events
# at the bottom first — scheduling, pulling, starting, failing all show up there.
kubectl describe pod app-pod -n node-react-mongo-redis

# Application logs (stdout/stderr of the container)
kubectl logs app-pod -n node-react-mongo-redis

# Where did it land, and what IP did it get?
kubectl get pod app-pod -n node-react-mongo-redis -o wide

# The full object as the API server stores it — note all the defaults
# Kubernetes filled in that you never wrote.
kubectl get pod app-pod -n node-react-mongo-redis -o yaml
```

## The deliberate failure

This Pod is told `MONGO_HOST=mongo`, but **no Service named `mongo` exists yet**.
Get a shell in and watch it fail honestly:

```bash
# The image is node:22-slim — no curl, but Node 22 has a global fetch(),
# which is the tidiest way to probe an app from inside its own container.
kubectl exec app-pod -n node-react-mongo-redis -- \
  node -e "fetch('http://localhost:3000/api/network-info').then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,1)))"
```

```jsonc
{
 "container_hostname": "app-pod",
 "version": "v1",
 "mongo_reachable": false,
 "mongo_error": "getaddrinfo ENOTFOUND mongo",   // <- DNS has nothing to resolve
 "redis_reachable": false,
 "redis_error": "getaddrinfo ENOTFOUND redis"
}
```

Or poke around interactively:

```bash
kubectl exec -it app-pod -n node-react-mongo-redis -- sh
env | grep -E 'MONGO|REDIS|APP_VERSION'
exit
```

`ENOTFOUND` is the lesson: **a Pod is an island.** It has an IP, but nothing
resolves the name `mongo` for it until you create a Service (step 6).

> **Why does `/api/health` still return ok?** Because the app's health endpoint
> deliberately does not touch Mongo or Redis. That distinction becomes the whole
> point of step 13 (Probes) — a liveness probe that checks your database will
> cascade a database outage into an app outage.

## Pods are mortal — prove it

```bash
kubectl delete pod app-pod -n node-react-mongo-redis
kubectl get pods -n node-react-mongo-redis
# gone. nothing brings it back. that is the problem ReplicaSets solve.
```

## 2b — Multi-container Pod (sidecar + initContainer)

```bash
kubectl apply -f 02-pod/multi-container-pod.yaml
kubectl get pod app-pod-with-sidecar -n node-react-mongo-redis
# READY 2/2  <- two containers in ONE pod
```

Watch the `initContainer` gate startup, then the sidecar reach the app over
`localhost` with no Service involved:

```bash
# init ran first and exited
kubectl logs app-pod-with-sidecar -n node-react-mongo-redis -c init-wait

# the sidecar curls http://localhost:3000 successfully — same network namespace
kubectl logs app-pod-with-sidecar -n node-react-mongo-redis -c poller -f
```

`-c <container>` is required whenever a Pod has more than one container.

## Cheat sheet

| Command | What it's for |
| ------- | ------------- |
| `kubectl describe pod <p>` | **Events** — why it's Pending/CrashLooping/ImagePullBackOff |
| `kubectl logs <p> -c <c>` | Application output |
| `kubectl logs <p> --previous` | Logs of the **crashed** instance — the CrashLoopBackOff lifesaver |
| `kubectl exec -it <p> -- sh` | Shell inside |
| `kubectl get pod <p> -o wide` | Node placement + Pod IP |
| `kubectl delete pod <p> --grace-period=0 --force` | Last resort for a stuck Pod |

## Clean up

```bash
kubectl delete -f 02-pod/ --ignore-not-found
```

---

**Prev:** [Step 1 — Namespace](../01-namespace/README.md) · **Next:** [Step 3 — Labels & Selectors](../03-labels-selectors/README.md)
