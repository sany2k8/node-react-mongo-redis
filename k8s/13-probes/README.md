# Step 13 — Probes

> **Liveness, Readiness, Startup.**

## The idea

Back in [step 5](../05-deployment/README.md) you caught Kubernetes lying:
`rollout status` said *"successfully rolled out"*, `kubectl get pods` said
`1/1 Running`, and the app answered `ECONNREFUSED`. Without probes, **"Ready"
means nothing more than "PID 1 hasn't exited"**.

Three probes, three completely different questions:

| Probe | Question | On failure | Affects |
| ----- | -------- | ---------- | ------- |
| **startup** | "has it finished booting?" | kill & restart | gates the other two |
| **liveness** | "should I **kill** this container?" | **restart** the container | `RESTARTS` |
| **readiness** | "should I send it **traffic**?" | **remove from Service endpoints** | `READY`, rollouts |

```
        container starts
              │
              ▼
     ┌──── startupProbe ────┐         liveness & readiness DISABLED
     │   (retry 30 × 2s)    │         until this passes once
     └──────────┬───────────┘
                │ pass
      ┌─────────┴─────────┐
      ▼                   ▼
 livenessProbe       readinessProbe
 fail → RESTART      fail → OUT OF ENDPOINTS (keeps running)
```

## 🔴 The one rule: liveness must never check a dependency

**Readiness may check dependencies. Liveness may not. Ever.**

A liveness probe should only fail for things a **restart can fix**: a deadlock,
a wedged event loop, an unrecoverable memory spiral. Your database being down is
not one of those. Restarting your app cannot fix someone else's database — it
just adds a restart storm to an existing outage, and the cold Pods then hammer
the recovering database with reconnects.

This is why the app's `/api/health` deliberately touches **nothing**, while
`/api/network-info` and `/api/items` touch Mongo and Redis.

## Apply it

```bash
NS=node-react-mongo-redis
kubectl apply -f 13-probes/app-deployment.yaml -f 13-probes/db-deployments.yaml

kubectl rollout status deploy/app -n $NS
kubectl get pods -n $NS
```

## Prove the rule — a live Mongo outage

Deploy two Pods that are **identical except for their liveness probe**:

```bash
kubectl apply -f 13-probes/broken-probe-demo.yaml
```

- `broken-liveness-checks-deps` → liveness on **`/api/items`** (queries Mongo, 503 when it's down)
- `deploy/app` → liveness on **`/api/health`** (checks nothing)

Now take Mongo down and watch:

```bash
kubectl scale deploy/mongo -n $NS --replicas=0

watch 'kubectl get pods -n node-react-mongo-redis -l component=app;
       kubectl get pod broken-liveness-checks-deps -n node-react-mongo-redis'
```

Real output:

```console
  [56:52] BROKEN: Running restarts=0   |   PROPER: 3 pods, 0 restarts
  [57:53] BROKEN: Running restarts=0   |   PROPER: 3 pods, 0 restarts
  [58:13] BROKEN: Running restarts=1   |   PROPER: 3 pods, 0 restarts   ← restart storm begins
  [58:54] BROKEN: Running restarts=2   |   PROPER: 3 pods, 0 restarts
```

```console
Warning  Unhealthy  Liveness probe failed: Get "http://10.244.2.65:3000/api/items":
                    context deadline exceeded
Normal   Killing    Container app failed liveness probe, will be restarted
```

```bash
kubectl scale deploy/mongo -n $NS --replicas=1   # restore
```

**Same app. Same outage. One config difference.** The dependency-checking Pod
restarts forever; the properly-probed Pods ride it out and recover the instant
Mongo returns. That is the whole lesson of this step.

## Prove it again — a probe pointed at the wrong port

```bash
kubectl get pod broken-liveness-wrong-port -n $NS
```

```console
NAME                         READY   STATUS    RESTARTS
broken-liveness-wrong-port   1/1     Running   5         ← climbing forever
```

The probe targets `:9999`; the app listens on `:3000`.

```console
Liveness probe failed: Get "http://10.244.1.54:9999/api/health":
                       dial tcp: connect: connection refused
Container app failed liveness probe, will be restarted
```

But the app is **perfectly healthy**:

```bash
kubectl exec broken-liveness-wrong-port -n $NS -- \
  node -e "fetch('http://localhost:3000/api/health').then(r=>r.text()).then(console.log)"
# {"status":"ok"}
```

A healthy app in `CrashLoopBackOff` because of one wrong number. This is what
"works locally, CrashLoopBackOffs in Kubernetes" nearly always is. Restart
backoff grows 10s → 20s → 40s → 80s, capped at 5 min.

```bash
kubectl delete -f 13-probes/broken-probe-demo.yaml   # clean up
```

## The startup probe

```yaml
startupProbe:
  httpGet: { path: /api/health, port: http }
  periodSeconds: 2
  failureThreshold: 30        # budget = 30 × 2s = 60s to boot
```

While it runs, **liveness and readiness are disabled entirely**. Once it passes
once, it never runs again.

This solves a real dilemma. Before startup probes, a slow-booting app forced you
to set a huge `initialDelaySeconds` on liveness — which meant that for the
container's *entire life*, a wedge took that long to detect. A startup probe
gives you a generous boot budget **and** a strict liveness probe afterward.

> Budget generously. If your app takes 65s to boot and the budget is 60s, the
> container is killed and restarted — forever. Slow boot is not a crime;
> an unbounded one is.

## Reading the manifest

```yaml
livenessProbe:            # kill it?  — be CONSERVATIVE
  httpGet: { path: /api/health, port: http }
  periodSeconds: 10
  failureThreshold: 3     # ~30s to notice a wedge
  timeoutSeconds: 3

readinessProbe:           # traffic?  — be AGGRESSIVE
  httpGet: { path: /api/health, port: http }
  periodSeconds: 3
  failureThreshold: 2     # ~6s to pull it from the load balancer
```

The asymmetry is the point: **pull traffic fast, restart slow.** Removing a Pod
from endpoints is cheap and reversible. Restarting it is neither.

| Field | Default | Notes |
| ----- | ------- | ----- |
| `initialDelaySeconds` | 0 | Prefer a `startupProbe` instead |
| `periodSeconds` | 10 | How often |
| `timeoutSeconds` | 1 | **Very tight.** A 1s default fails a lot of real apps |
| `failureThreshold` | 3 | Time to detect = `period × threshold` |
| `successThreshold` | 1 | Must be 1 for liveness/startup — the API rejects >1 |

## The four probe types

```yaml
httpGet:  { path: /api/health, port: http }   # 200-399 = pass. Most common.
exec:     { command: ["sh","-c","..."] }      # exit 0 = pass. Costs a process fork.
tcpSocket: { port: 3000 }                     # can we open a socket? Weak — a
                                              # wedged app still accepts connections.
grpc:     { port: 50051 }                     # k8s 1.24+
```

The database Deployments use `exec` because Mongo and Redis don't speak HTTP:

```yaml
# mongo — `ping` is allowed pre-auth, so the probe survives credential rotation
exec:
  command: ["mongosh", "--quiet", "--eval", "db.adminCommand('ping')"]

# redis — REDISCLI_AUTH keeps the password out of the pod spec and logs.
# `redis-cli -a <pass>` would leak it to anyone with `kubectl get pod`.
exec:
  command: ["sh","-c",'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping | grep -q PONG']
```

> `httpGet` probes are sent **by the kubelet from the node**, not from inside the
> Pod — they bypass your service mesh and any `NetworkPolicy` you wrote. And
> `host` defaults to the **Pod IP**, not localhost.

## Designing the endpoints

| Endpoint | Checks | Used by |
| -------- | ------ | ------- |
| `/api/health` | nothing — just "am I responsive?" | **liveness** |
| `/readyz` | dependencies I *need* to serve | **readiness** |
| `/api/network-info` | everything, verbosely | humans & dashboards |

A good readiness endpoint checks only what you need **to serve a request**. If
your app can serve 90% of traffic without Redis, don't fail readiness on Redis —
you'll take yourself down over a cache.

> ### A health endpoint that lies
> `/api/network-info` reports `mongo_reachable: true` against a **dead Mongo**,
> because the backend caches the collection handle after the first successful
> connect and never re-pings. It answers *"have I ever connected?"*, not *"is
> Mongo up?"*.
>
> This lab's first attempt at the dependency-check demo used it as a probe and
> silently never fired — a no-op demo that looked fine. **If your health check
> can't fail, it isn't a health check.** Test yours by actually breaking the
> thing it claims to check.

## Graceful shutdown — the other half of zero downtime

Probes get traffic *to* healthy Pods. This gets it *away* from dying ones.

```yaml
terminationGracePeriodSeconds: 30
lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 5"]
```

On Pod deletion, two things happen **in parallel**:

```
   ┌── endpoint removal ──► kube-proxy on node A ─┐
   │                     ──► kube-proxy on node B ─┤  takes time to propagate
   │                     ──► kube-proxy on node C ─┘
   └── preStop hook ──► SIGTERM ──► (grace period) ──► SIGKILL
```

Nothing synchronizes them. If your app exits instantly on SIGTERM, traffic that
was routed a moment ago arrives at a dead Pod → **connection refused**. That's
the "we get 502s on every deploy" bug.

`preStop: sleep 5` delays SIGTERM so endpoint removal propagates first. The Pod
is already out of rotation, so the wait costs nothing. Belt and braces: also
handle SIGTERM in the app (stop accepting, drain in-flight, then exit).

## Debugging probes

```bash
kubectl describe pod <pod> -n $NS | grep -A5 -E 'Liveness|Readiness|Startup'
kubectl get events -n $NS --field-selector reason=Unhealthy

# logs from the instance that DIED — the CrashLoopBackOff lifesaver
kubectl logs <pod> -n $NS --previous

# run the probe by hand
kubectl exec <pod> -n $NS -- <the exec command>
```

| Symptom | Likely cause |
| ------- | ------------ |
| `CrashLoopBackOff`, app fine by hand | liveness wrong port/path, or too tight |
| `Running` but `0/1` forever | readiness failing — check path & port |
| Restarts during a dependency outage | **liveness checks a dependency** — fix it |
| `Unhealthy: context deadline exceeded` | `timeoutSeconds` too low (default is 1s!) |
| Restarts only at startup | needs a `startupProbe`, or a bigger budget |
| Service returns nothing, pods look up | readiness failing → empty EndpointSlice (step 6) |
| Probe passes but users get errors | probe too shallow (`tcpSocket` on a wedged app) |

## Clean up

```bash
kubectl delete -f 13-probes/broken-probe-demo.yaml --ignore-not-found
```

---

**Prev:** [Step 12 — Rolling Updates & Rollbacks](../12-rolling-update-rollback/README.md) · **Next:** [Step 14 — Helm & Helmfile](../14-helm/README.md)
