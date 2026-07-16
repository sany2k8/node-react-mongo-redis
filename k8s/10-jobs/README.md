# Step 10 — Jobs

> **One-off initialization scripts and migrations.**

## The idea

Everything so far runs forever. A **Job** runs Pods until they **succeed**, then
stops. That inversion changes the rules:

| | Deployment | Job |
| - | ---------- | --- |
| Goal | N Pods running, forever | N Pods **succeeded**, then stop |
| `restartPolicy` | `Always` (enforced) | `Never` or `OnFailure` — **`Always` is rejected** |
| Pod exits 0 | restarted anyway | counts as success |
| Failure handling | restart forever | `backoffLimit`, then Job = Failed |
| Cleanup | n/a | `ttlSecondsAfterFinished` |

This is what you use for schema migrations, data seeds, backups, and batch work.

## Apply the seed Job

```bash
NS=node-react-mongo-redis
kubectl apply -f 10-jobs/seed-job.yaml

kubectl wait --for=condition=complete job/seed-db -n $NS --timeout=180s
kubectl logs job/seed-db -n $NS
```

```console
==> waiting for mongo to accept connections
==> mongo is up. seeding labdb.items
==> inserted 4 new, total docs: 5
==> seed complete
```

```bash
kubectl get job seed-db -n $NS
# NAME      STATUS     COMPLETIONS   DURATION
# seed-db   Complete   1/1           5s
```

Check it through the app:

```bash
kubectl port-forward -n $NS svc/app 8080:80 &
curl -s localhost:8080/api/items | python3 -m json.tool
kill %1
```

## 🔑 Design every Job to be idempotent

This is the rule that separates a Job that works from a Job that ruins your
weekend. Jobs get retried — by `backoffLimit`, by a re-`apply`, by a Helm hook
on every upgrade, by a nervous engineer running it twice. **Running twice must
be harmless.**

The seed Job uses a unique index plus `updateOne(..., {upsert:true})`:

```js
db.items.createIndex({ name: 1 }, { unique: true });
db.items.updateOne(
  { name: name },
  { $setOnInsert: { name: name, created_at: new Date().toISOString() } },
  { upsert: true }
);
```

Prove it — run the exact same Job again:

```bash
kubectl delete job seed-db -n $NS
kubectl apply -f 10-jobs/seed-job.yaml
kubectl wait --for=condition=complete job/seed-db -n $NS --timeout=180s
kubectl logs job/seed-db -n $NS | grep inserted
```

```console
==> inserted 0 new, total docs: 5     ← no duplicates. Safe to re-run forever.
```

A naive `db.items.insertMany(seeds)` would have given you 9 documents, then 13.

> **Jobs are immutable.** You cannot edit a Job's `spec.template` — try it and
> the API server says `field is immutable`. You must `delete` and re-create.
> This is why re-running is the normal workflow, and why idempotency matters.
> (Helm handles this with `"helm.sh/hook-delete-policy": before-hook-creation`.)

## Jobs have no ordering — handle it yourself

Nothing guarantees Mongo is up when your Job starts. There is no `depends_on`.
Two idiomatic fixes:

**1. Poll in the script** (what `seed-job.yaml` does):

```bash
until mongosh "$URI" --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; do
  echo "mongo not ready, retrying in 2s..."; sleep 2
done
```

**2. An `initContainer`** — gate the main container on a dependency:

```yaml
spec:
  initContainers:
    - name: wait-for-mongo
      image: busybox:1.36
      command: ['sh','-c','until nc -z mongo 27017; do echo waiting; sleep 2; done']
  containers:
    - name: migrate
      ...
```

Either way, **make it time out** (`activeDeadlineSeconds`) so a missing
dependency fails the deploy instead of hanging it forever.

## The knobs

```yaml
spec:
  backoffLimit: 3             # retries before Failed. Each retry = a NEW pod.
  activeDeadlineSeconds: 300  # wall-clock cap for the whole Job, retries included
  ttlSecondsAfterFinished: 300 # auto-delete Job+Pods 5 min after finishing
  completions: 6              # how many pods must succeed
  parallelism: 2              # how many may run at once
  completionMode: Indexed     # give each pod a unique index
```

| Field | Why you care |
| ----- | ------------ |
| `backoffLimit` | Retries back off exponentially: 10s, 20s, 40s… capped at 6m. |
| `activeDeadlineSeconds` | **Always set it.** Beats `backoffLimit` — kills the Job even mid-run. Without it a hung migration blocks a release forever. |
| `ttlSecondsAfterFinished` | Without it, finished Jobs accumulate in the namespace until they hit your quota. |
| `restartPolicy: Never` | Failed Pods are **kept** — you keep the logs. With `OnFailure` the container restarts in place and you lose them. |

## Parallel Jobs (work-queue pattern)

```bash
kubectl apply -f 10-jobs/parallel-job.yaml
kubectl get job parallel-demo -n $NS -w    # watch 0/6 → 2/6 → 4/6 → 6/6
```

`completions: 6` + `parallelism: 2` = three waves of two.

```bash
kubectl logs -n $NS -l job-name=parallel-demo --tail=-1 | grep starting | sort
```

```console
worker for shard 0 starting on parallel-demo-0
worker for shard 1 starting on parallel-demo-1
worker for shard 2 starting on parallel-demo-2
worker for shard 3 starting on parallel-demo-3
worker for shard 4 starting on parallel-demo-4
worker for shard 5 starting on parallel-demo-5
```

`completionMode: Indexed` is the useful bit: each Pod gets a unique index in
`$JOB_COMPLETION_INDEX` **and a stable hostname** (`parallel-demo-3`). That lets
you shard deterministically with no queue at all — Pod *N* handles rows where
`id % 6 == N`. With the default `NonIndexed`, Pods are interchangeable and you
need a real work queue (Redis, SQS) to hand out tasks.

## Watch a Job fail

Understanding the failure path is what you'll actually need at 2am:

```bash
kubectl apply -f 10-jobs/failing-job.yaml
kubectl get pods -n $NS -l job-name=failing-demo -w
```

```console
NAME                 STATUS
failing-demo-jjrd5   Error      ← attempt 1
failing-demo-lvpwl   Error      ← retry 1, ~10s later
failing-demo-qrll6   Error      ← retry 2, ~20s later
```

```bash
kubectl get job failing-demo -n $NS
# NAME           STATUS   COMPLETIONS   DURATION
# failing-demo   Failed   0/1           42s

kubectl get job failing-demo -n $NS -o jsonpath='{.status.conditions}' | python3 -m json.tool
# "reason": "BackoffLimitExceeded",
# "message": "Job has reached the specified backoff limit"
```

`backoffLimit: 2` → 1 attempt + 2 retries = **3 Pods**. All three are kept
(`restartPolicy: Never`), so you can read every attempt's logs:

```bash
kubectl logs -n $NS -l job-name=failing-demo --tail=-1
kubectl describe job failing-demo -n $NS
```

## CronJob — a Job factory on a schedule

```bash
kubectl apply -f 10-jobs/cronjob.yaml
kubectl get cronjob -n $NS
```

```console
NAME          SCHEDULE      TIMEZONE   SUSPEND   ACTIVE   LAST SCHEDULE
item-report   */2 * * * *   Etc/UTC    False     0        <none>
```

Three objects deep — `CronJob` → `Job` (one per tick) → `Pod`:

```bash
# wait ~2 min, then
kubectl get jobs -n $NS -l component=cron
kubectl logs -n $NS -l component=cron --tail=-1
```

```console
[report] 2026-07-16T16:30:00.123Z
[report] total items: 5
```

The fields that bite people:

| Field | Why |
| ----- | --- |
| `timeZone` | Defaults to the **controller's** TZ (usually UTC). This is how a "midnight" backup runs at 5pm. |
| `concurrencyPolicy: Forbid` | Previous run still going? Skip. Use for backups/migrations — `Allow` (the default) will happily run two at once. |
| `startingDeadlineSeconds` | After a controller outage, how late may a missed run start? Without it you get a thundering herd. **Miss 100 schedules and the CronJob stops permanently.** |
| `successfulJobsHistoryLimit` | Keep N finished Jobs for log inspection. |
| `suspend: true` | Pause without deleting — flip it during an incident. |

```bash
# trigger a run right now instead of waiting
kubectl create job --from=cronjob/item-report manual-report-1 -n $NS
kubectl logs job/manual-report-1 -n $NS

# pause / resume
kubectl patch cronjob item-report -n $NS -p '{"spec":{"suspend":true}}'
kubectl patch cronjob item-report -n $NS -p '{"spec":{"suspend":false}}'
```

## Jobs in a real deploy pipeline

The migration-before-deploy problem is what Helm hooks solve (step 14):

```yaml
metadata:
  annotations:
    "helm.sh/hook": pre-upgrade,pre-install
    "helm.sh/hook-weight": "-5"            # lower runs first
    "helm.sh/hook-delete-policy": before-hook-creation,hook-succeeded
```

`helm upgrade` then runs the migration Job **and waits for it to succeed**
before touching the Deployment. If the migration fails, the app is never rolled
out. `before-hook-creation` deletes the previous Job first — necessary, because
Jobs are immutable.

## Clean up

```bash
kubectl delete -f 10-jobs/ --ignore-not-found
kubectl delete job -n $NS --all
```

---

**Prev:** [Step 9 — PersistentVolume & PVC](../09-persistent-volume/README.md) · **Next:** [Step 11 — HPA](../11-hpa/README.md)
