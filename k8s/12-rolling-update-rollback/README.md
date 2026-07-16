# Step 12 — Rolling Updates & Rollbacks

> **Zero-downtime updates.**

## The idea

A Deployment never mutates a Pod. To change anything in `spec.template` it
creates a **new ReplicaSet** and shifts replicas across, bounded by
`maxSurge`/`maxUnavailable`:

```
revision 6 (v1)   RS app-9df9dbfc5   3 → 3 → 2 → 1 → 0
revision 7 (v2)   RS app-6c8b749f99  0 → 1 → 2 → 3 → 3
                                      └── both serve traffic here ──┘
```

The old ReplicaSet is kept at 0 replicas. **That's your undo history** —
`rollout undo` simply scales it back up.

The `v1` and `v2` images here were built from identical source with a different
`APP_VERSION` build arg, so `GET /api/` reports which one answered. The rollout
is observable, not a matter of faith.

## Setup

```bash
NS=node-react-mongo-redis

# an HPA would fight `replicas:` on every apply — see step 11
kubectl delete hpa app-hpa -n $NS --ignore-not-found

kubectl apply -f 08-configmap-secret/app-deployment.yaml
kubectl annotate deploy/app -n $NS kubernetes.io/change-cause="Initial v1 deploy" --overwrite
```

To watch the rollout you need to reach the **Service** (which load balances), not
a single Pod. Start the socat proxy from [step 6](../06-service/README.md):

```bash
docker run -d --name k8s-np-proxy --network kind -p 30300:30300 alpine/socat \
  tcp-listen:30300,fork,reuseaddr tcp-connect:172.18.0.3:30300
```

> ### ⚠️ Do NOT use `kubectl port-forward` for this
> Port-forward **pins to one Pod and does not load balance** (step 7). Poll
> through it during a rollout and you get this:
> ```console
> 100 v1     ← every single request, while the rollout completed to v2
> ```
> The rollout worked perfectly; the tunnel just never left the old Pod. It's an
> easy trap — it caught this lab's own first test run.

## 🚀 Watch a zero-downtime rollout

```bash
# terminal 1 — poll the Service continuously
while true; do
  curl -s --max-time 2 localhost:30300/api/ | python3 -c 'import sys,json; print(json.load(sys.stdin)["version"])' 2>/dev/null || echo FAILED
  sleep 0.5
done

# terminal 2
kubectl apply -f 12-rolling-update-rollback/app-deployment-v2.yaml
kubectl rollout status deploy/app -n $NS
```

Real output from 120 polled requests:

```console
v1 v1 v1 v1 v1 v1 v1 v1 v1 v1 v1 v2 v2 v2 v1 v1 v2 v1 v1 v1 v1 v2 v1 v2 v1 v1 v1 v2 v1 v2 v1 v1
v1 v2 v1 v2 v1 v2 v2 v1 v2 v2 v2 v1 v1 v1 v1 v2 v1 v2 v2 v1 v2 v1 v2 v2 v2 v1 v1 v1 v1 v2 v1 v2
v2 v2 v1 v2 v2 v2 v2 v1 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2
v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2 v2

  42 v1
  78 v2
   0 FAILED     ← zero downtime, empirically
```

### 🔑 The lesson hiding in that output

There is a long window where **v1 and v2 serve simultaneously**. That is not a
bug — it is unavoidable in any rolling update. It means:

- **Your v1 and v2 must be compatible with each other**, at the API *and* the
  database schema level.
- Never ship a migration that v1 can't tolerate in the same release that needs
  it. Use expand/contract: add a nullable column → deploy code that writes both →
  backfill → deploy code that reads new → drop old. Four releases, not one.
- A client that gets v1 then v2 on consecutive requests must not break.

If you need a hard cutover, that's a Recreate strategy (downtime) or a
blue/green switch (flip a Service selector) — not a rolling update.

## 💥 Now break it on purpose

```bash
kubectl apply -f 12-rolling-update-rollback/app-deployment-broken.yaml
```

The image tag `v99-does-not-exist` cannot be pulled. Watch:

```bash
kubectl get pods -n $NS -l component=app
```

```console
NAME                  READY   STATUS             RESTARTS
app-79ff7f895-6qtd9   0/1     ImagePullBackOff   0          ← the new one, dead
app-9df9dbfc5-5fhw5   1/1     Running            0          ← old ones: untouched
app-9df9dbfc5-5t756   1/1     Running            0
app-9df9dbfc5-b74ls   1/1     Running            0
```

```bash
kubectl rollout status deploy/app -n $NS
# error: deployment "app" exceeded its progress deadline

kubectl get deploy app -n $NS -o jsonpath='{range .status.conditions[*]}{.type}={.status} reason={.reason}{"\n"}{end}'
```

```console
Available=True    reason=MinimumReplicasAvailable   ← still serving!
Progressing=False reason=ProgressDeadlineExceeded   ← rollout gave up
```

And the users?

```console
  70 v2
   0 FAILED     ← nobody noticed. At all.
```

**A completely broken deploy caused zero user impact.** That is `maxUnavailable: 0`
doing its job: Kubernetes may not remove an old Pod until a new one is Ready,
and the new one never became Ready, so the rollout simply stalled — safely.

> ### ⚠️ Kubernetes does NOT auto-rollback
> `progressDeadlineSeconds` only *reports* failure by flipping a condition. The
> Deployment sits wedged forever until a human or a pipeline acts. Auto-rollback
> is a CI/CD concern — `helm upgrade --atomic`, Argo Rollouts, Flagger.

## Rollback

```bash
kubectl rollout history deploy/app -n $NS
```

```console
REVISION  CHANGE-CAUSE
2         <none>                                      ← why you set change-cause
3         <none>
6         Initial v1 deploy
7         Upgrade app to v2
8         BROKEN: deploy v99 (tag does not exist)
```

```bash
# undo the last rollout
kubectl rollout undo deploy/app -n $NS
kubectl rollout status deploy/app -n $NS
```

The `ImagePullBackOff` Pod is gone and you're back on v2. Or target a revision:

```bash
kubectl rollout history deploy/app -n $NS --revision=6   # inspect it first
kubectl rollout undo deploy/app -n $NS --to-revision=6   # back to v1
curl -s localhost:30300/api/ | python3 -m json.tool      # "version": "v1"
```

Two things to notice in the history afterwards:

```console
REVISION  CHANGE-CAUSE
6         Initial v1 deploy
8         BROKEN: deploy v99 (tag does not exist)
9         Upgrade app to v2          ← undo created revision 9, it didn't restore 7
```

1. **Revision numbers are never reused.** An undo rolls *forward* to a new
   revision with old content. Revision 7 is gone from the list.
2. `revisionHistoryLimit: 5` caps this list. Beyond it, old ReplicaSets are
   garbage collected and **those revisions become un-rollback-able**. Set it to
   0 and you cannot roll back at all.

> ### ⚠️ The `undo` + `apply` warning is real
> ```
> Warning: resource deployments/app was previously managed with 'kubectl apply'.
> Rolling back will not update the kubectl.kubernetes.io/last-applied-configuration
> annotation, which may cause unexpected behavior on future 'kubectl apply'
> ```
> `rollout undo` changes the live object but **not** the annotation `apply` diffs
> against. Your next `kubectl apply -f` re-applies the file and silently undoes
> your rollback. In GitOps terms: **the rollback isn't real until it's in git.**
> Treat `rollout undo` as an emergency stop, then fix the manifest.

## The fields that matter

```yaml
spec:
  minReadySeconds: 10           # Ready for 10s straight before counting as available
  progressDeadlineSeconds: 120  # report failure after 120s of no progress
  revisionHistoryLimit: 5       # how many revisions you can roll back to
  strategy:
    rollingUpdate:
      maxUnavailable: 0         # never drop below `replicas` ready
      maxSurge: 1               # at most +1 extra pod
```

| Field | Why it matters |
| ----- | -------------- |
| `maxUnavailable: 0` | The zero-downtime guarantee. Costs one extra Pod's capacity. |
| `minReadySeconds` | Cheapest protection against a container that starts, passes one probe, then crashes. The rollout stalls instead of marching on. |
| `progressDeadlineSeconds` | Must be **>** `initialDelaySeconds + (periodSeconds × failureThreshold)`, or a slow-starting app "fails" a rollout that was fine. |
| `revisionHistoryLimit` | Your undo depth. |
| `kubernetes.io/change-cause` | Otherwise history is a wall of `<none>`. |

## Triggering and controlling rollouts

```bash
# restart every pod without changing anything (picks up ConfigMap changes — step 8)
kubectl rollout restart deploy/app -n $NS

# batch several edits into ONE rollout
kubectl rollout pause deploy/app -n $NS
kubectl set image deploy/app app=sany2k8/node-react-mongo-redis-app:v2 -n $NS
kubectl set resources deploy/app -c app --limits=cpu=500m -n $NS
kubectl rollout resume deploy/app -n $NS      # now it rolls, once

# set change-cause as you go
kubectl set image deploy/app app=...:v2 -n $NS
kubectl annotate deploy/app kubernetes.io/change-cause="Upgrade to v2" -n $NS
```

`rollout restart` works by stamping `kubectl.kubernetes.io/restartedAt` into the
Pod template — a template change, so the normal rolling-update machinery runs.
It is not a special code path.

## Beyond rolling updates

| Strategy | How | Trade-off |
| -------- | --- | --------- |
| **RollingUpdate** | built in | mixed versions during rollout |
| **Recreate** | `strategy.type: Recreate` | downtime, but never mixed |
| **Blue/Green** | two Deployments, flip the Service selector | instant cutover + instant rollback, 2× cost |
| **Canary** | two Deployments sharing a Service, ratio by replica count | crude; use a service mesh for real % splits |
| **Progressive** | Argo Rollouts / Flagger | automated analysis + **real** auto-rollback |

Blue/green with the tools you already have from step 3 — the Service selector is
just a label query:

```bash
kubectl patch svc app -n $NS -p '{"spec":{"selector":{"version":"v2"}}}'   # cut over
kubectl patch svc app -n $NS -p '{"spec":{"selector":{"version":"v1"}}}'   # instant rollback
```

## Clean up

```bash
kubectl apply -f 12-rolling-update-rollback/app-deployment-v2.yaml   # settle on v2
docker rm -f k8s-np-proxy    # if you're done with it
```

---

**Prev:** [Step 11 — HPA](../11-hpa/README.md) · **Next:** [Step 13 — Probes](../13-probes/README.md)
