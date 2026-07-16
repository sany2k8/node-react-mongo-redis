# Step 5 — Deployment

> **Declarative updates to Pods and ReplicaSets.**

## The idea

Step 4 ended on a cliff: a ReplicaSet reconciles *count*, never *content*.
Change its image and existing Pods keep running the old one forever.

A Deployment closes that gap. It is a controller **whose Pods are ReplicaSets**:

```
Deployment "app"
├── ReplicaSet app-7d9f8  (revision 2, replicas: 3)  ← current
│   ├── Pod app-7d9f8-abc
│   ├── Pod app-7d9f8-def
│   └── Pod app-7d9f8-ghi
└── ReplicaSet app-5c4b1  (revision 1, replicas: 0)  ← kept for rollback
```

Every edit to `spec.template` hashes to a new ReplicaSet. The Deployment then
**shifts replicas from old to new**, respecting `maxSurge`/`maxUnavailable`.
The old ReplicaSet sticks around at zero replicas — that's your undo history.

## Apply the whole stack

```bash
NS=node-react-mongo-redis
kubectl apply -f 05-deployment/

kubectl get deploy,rs,pods -n $NS
```

```console
NAME                    READY   UP-TO-DATE   AVAILABLE
deployment.apps/app     3/3     3            3
deployment.apps/mongo   1/1     1            1
deployment.apps/redis   1/1     1            1
```

Note the naming chain — `app` → `app-<template-hash>` → `app-<template-hash>-<random>`:

```bash
kubectl get rs -n $NS -o wide
kubectl get pods -n $NS -L version
```

That `<template-hash>` is a hash of the Pod template. It is also injected into
every Pod as the `pod-template-hash` label, and **added to the ReplicaSet's
selector automatically** — that's what stops revision 1's RS from adopting
revision 2's Pods even though your selector (`app`+`component`) matches both.

```bash
# your selector said 2 labels; the RS actually has 3
kubectl get rs -n $NS -o jsonpath='{.items[0].spec.selector.matchLabels}' | python3 -m json.tool
```

## Now fix what step 4 couldn't

```bash
kubectl set image deploy/app app=sany2k8/node-react-mongo-redis-app:v2 -n $NS
kubectl rollout status deploy/app -n $NS

# every pod is v2 now — no manual deletion, no downtime
kubectl get pods -n $NS -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[0].image}{"\n"}{end}'

# and there are now two ReplicaSets
kubectl get rs -n $NS
```

Put it back — step 12 covers rollout/rollback properly:

```bash
kubectl rollout undo deploy/app -n $NS
```

### A lie you can catch right now

Immediately after that `rollout undo` reports success, run:

```bash
kubectl exec deploy/app -n $NS -- \
  node -e "fetch('http://localhost:3000/api/health').then(r=>r.text()).then(console.log)"
```

You will likely get **`ECONNREFUSED 127.0.0.1:3000`**:

```
AggregateError [ECONNREFUSED]
    Error: connect ECONNREFUSED 127.0.0.1:3000
```

Read that carefully. `kubectl rollout status` printed *"successfully rolled
out"*, `kubectl get pods` says `1/1 Running`, and the app **is not accepting
connections yet.** Node hasn't finished booting.

Nothing is broken — this Deployment has no `readinessProbe`, so "Ready" means
nothing more than *"the container's PID 1 has not exited"*. Kubernetes has no
idea whether your app can serve a request, and in step 6 a Service will happily
load-balance real traffic straight into that gap on every single deploy.

Wait ten seconds and it answers fine. That transient window — invisible here,
a burst of 502s in production — is the entire justification for
[step 13](../13-probes/README.md).

## The three controllers, side by side

| | Pod | ReplicaSet | Deployment |
| - | --- | ---------- | ---------- |
| Self-heals | ✗ | ✓ | ✓ |
| Scales | ✗ | ✓ | ✓ |
| Updates existing Pods | ✗ | ✗ | ✓ |
| Rollback history | ✗ | ✗ | ✓ |
| You should write one | rarely | almost never | **yes** |

## `strategy` — the two knobs that matter

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1   # how far below `replicas` you'll dip
    maxSurge: 1         # how far above `replicas` you'll go
```

With `replicas: 3`, `maxUnavailable: 1`, `maxSurge: 1` → between 2 and 4 Pods
exist at any moment. Both accept percentages (`25%`).

| Goal | Setting |
| ---- | ------- |
| Never lose capacity | `maxUnavailable: 0, maxSurge: 1` — needs quota headroom |
| Never exceed capacity (tight quota / licensed software) | `maxUnavailable: 1, maxSurge: 0` |
| Fastest, capacity be damned | `maxUnavailable: 100%, maxSurge: 100%` |
| Single-writer (databases) | `type: Recreate` — kill all, then start |

**`maxUnavailable: 0` and `maxSurge: 0` together is invalid** — that's a
deadlock and the API server rejects it.

`mongo` and `redis` here use `type: Recreate` on purpose: two Mongo Pods must
never hold the same data volume at once. RollingUpdate would briefly run both.

## Why the app still can't reach Mongo

```bash
kubectl exec deploy/app -n $NS -- \
  node -e "fetch('http://localhost:3000/api/network-info').then(r=>r.json()).then(j=>console.log(j.mongo_error||'mongo OK'))"
# getaddrinfo ENOTFOUND mongo
```

Mongo is *running*, in the same namespace, and the app still can't find it —
because **Pods have no stable name or IP, and nothing publishes them.**
`kubectl get pods -o wide` shows Mongo's Pod IP, but that IP changes every
restart. You need a stable front door. That's step 6.

> `kubectl exec deploy/app` picks one Pod from the Deployment automatically —
> handy shorthand.

## Useful commands

```bash
kubectl rollout status deploy/app -n $NS       # block until rolled out
kubectl rollout history deploy/app -n $NS      # revision list
kubectl rollout pause deploy/app -n $NS        # batch several edits
kubectl rollout resume deploy/app -n $NS
kubectl scale deploy/app -n $NS --replicas=5
kubectl describe deploy/app -n $NS             # events + strategy + conditions

# what changed between the live object and the file?
kubectl diff -f 05-deployment/app-deployment.yaml
```

`kubectl diff` before `kubectl apply` is the single best habit in this list.

## Clean up

Leave it running — step 6 builds directly on it.

---

**Prev:** [Step 4 — ReplicaSet](../04-replicaset/README.md) · **Next:** [Step 6 — Service](../06-service/README.md)
