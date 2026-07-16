# Step 11 — Horizontal Pod Autoscaler

> **Dynamic autoscaling.**

## The idea

The HPA is step 4's reconciliation loop again, one level up. Every ~15s it:

1. Reads Pod metrics from `metrics.k8s.io`
2. Computes `desired = ceil(currentReplicas × (currentMetric / targetMetric))`
3. Writes the result to the Deployment's `/scale` subresource

It never touches Pods. It only changes `replicas` and lets
Deployment → ReplicaSet → Pod do the work.

```
metrics-server ──► metrics.k8s.io ──► HPA ──► Deployment.spec.replicas
   (scrapes                            (loop)      │
    kubelets)                                      ▼
                                            ReplicaSet ──► Pods
```

## First: install metrics-server

**Your cluster does not have it.** Nothing in `kubectl top` or HPA works without it:

```bash
kubectl top nodes
# error: Metrics API not available
```

A pinned, kind-ready copy is included here:

```bash
kubectl apply -f 11-hpa/metrics-server.yaml
kubectl rollout status deploy/metrics-server -n kube-system
sleep 30    # give it a scrape cycle

kubectl top nodes
kubectl top pods -n node-react-mongo-redis
```

```console
NAME                    CPU(cores)   CPU(%)   MEMORY(bytes)   MEMORY(%)
desktop-control-plane   161m         2%       1172Mi          7%
desktop-worker          77m          0%       1442Mi          8%
desktop-worker2         155m         1%       1188Mi          7%
```

> **Why the local copy instead of the upstream URL?** The stock manifest fails on
> kind/Docker Desktop. metrics-server scrapes each kubelet over HTTPS and
> validates the cert against the cluster CA, but kind nodes use **self-signed
> kubelet serving certs**. Every scrape dies with
> `x509: cannot validate certificate ... doesn't contain any IP SANs`, and the
> Deployment never goes Ready. The one-line fix is `--kubelet-insecure-tls`,
> already applied in `metrics-server.yaml`.
>
> That flag is fine for a laptop. In a real cluster, fix it properly with
> kubelet serving-cert rotation (`--rotate-server-certificates`) instead of
> disabling verification.

It installs cluster-wide into `kube-system`. Remove it with
`kubectl delete -f 11-hpa/metrics-server.yaml`.

## Apply the HPA

```bash
NS=node-react-mongo-redis
kubectl apply -f 11-hpa/app-hpa.yaml -f 11-hpa/load-generator.yaml

kubectl get hpa -n $NS
```

```console
NAME      REFERENCE        TARGETS                              MINPODS   MAXPODS   REPLICAS
app-hpa   Deployment/app   cpu: 1%/50%, memory: 42372Ki/150Mi   2         8         3
```

If `TARGETS` shows `<unknown>`, wait ~30s for a scrape. If it stays unknown,
read the troubleshooting table at the bottom — it's almost always a missing
`resources.requests`.

## 🔥 Watch it scale up

```bash
# terminal 1
kubectl get hpa app-hpa -n $NS -w

# terminal 2
kubectl get pods -n $NS -l component=app -w

# terminal 3 — apply load
kubectl scale deploy/load-generator -n $NS --replicas=4
```

Real output from this lab:

```console
  time   cpu%  desired  ready-pods
  21:21    97%      3        3        ← load hits
  22:02    88%      4        4        ← SuccessfulRescale: New size: 4
  24:23    62%      5        5        ← New size: 5
  25:37    46%      5        5        ← settling...
  28:40    41%      5        5        ← equilibrium
```

```bash
kubectl describe hpa app-hpa -n $NS | tail -5
```

```console
Normal  SuccessfulRescale  6m59s  New size: 4; reason: cpu resource utilization (percentage of request) above target
Normal  SuccessfulRescale  4m44s  New size: 5; reason: cpu resource utilization (percentage of request) above target
```

**Five Pods holding ~44% against a 50% target.** That's the loop finding
equilibrium, not overshooting. It stops scaling because 44% < 50%.

## ❄️ Watch it scale down

```bash
kubectl scale deploy/load-generator -n $NS --replicas=0
```

```console
  time   cpu%  desired  ready-pods
  29:13    42%      5        5
  29:53     9%      5        5       ← load gone, but no scale-down yet...
  30:14     0%      5        5       ← ...still waiting (stabilization window)
  30:34     1%      2        2       ← now it drops, straight to minReplicas
```

```console
Normal  SuccessfulRescale  3m40s  New size: 4; reason: All metrics below target
Normal  SuccessfulRescale  3m24s  New size: 2; reason: All metrics below target
```

Notice CPU hit 0% at 30:14 but nothing happened until 30:34. That delay is
`scaleDown.stabilizationWindowSeconds: 60` — and it's the single most important
HPA setting.

## The formula, and why utilization is a % of *request*

```
desired = ceil(currentReplicas × (currentMetricValue / targetMetricValue))
```

With 3 Pods averaging 97m CPU and a 50m target (50% of the 100m **request**):

```
ceil(3 × (97 / 50)) = ceil(5.82) = 6   → capped by policy/maxReplicas
```

> ### ⚠️ `averageUtilization` is a percentage of the Pod's `requests`
> **Not** the limit. **Not** the node's capacity.
>
> This app requests `cpu: 100m`, so `averageUtilization: 50` means **50m of
> actual CPU**. Change the request to `200m` and the same real load now reads as
> half the utilization — and your HPA silently stops scaling.
>
> **A Pod with no `resources.requests.cpu` cannot be autoscaled on CPU
> utilization at all.** The HPA reports `<unknown>` forever. This is the #1
> reason HPAs don't work.

The HPA also has a **10% tolerance** — it ignores ratios between 0.9 and 1.1 to
avoid flapping. At a 50% target it won't act until you're outside 45–55%.

## Multiple metrics

```yaml
metrics:
  - type: Resource
    resource: { name: cpu,    target: { type: Utilization,  averageUtilization: 50 } }
  - type: Resource
    resource: { name: memory, target: { type: AverageValue, averageValue: 150Mi } }
```

The HPA computes a desired count for **every** metric and takes the **highest**.
Metrics can only push you *up* relative to one another — never down. So adding a
metric can only ever make you scale out more, never less.

| Target type | Meaning |
| ----------- | ------- |
| `Utilization` | % of the pod's **request** (CPU/memory only) |
| `AverageValue` | absolute value **per pod** |
| `Value` | absolute value **total across all pods** |

Beyond CPU/memory you can scale on `Pods`, `Object`, and `External` metrics —
requests/sec from Prometheus, SQS queue depth, Kafka lag — via a custom metrics
adapter (`prometheus-adapter`, KEDA). **Queue depth is usually a far better
scaling signal than CPU** for a worker.

## `behavior` — the anti-flapping controls

```yaml
behavior:
  scaleUp:
    stabilizationWindowSeconds: 30   # default 0 — react instantly
    policies:
      - { type: Percent, value: 100, periodSeconds: 15 }   # at most double / 15s
      - { type: Pods,    value: 4,   periodSeconds: 15 }   # or +4 pods / 15s
    selectPolicy: Max
  scaleDown:
    stabilizationWindowSeconds: 60   # DEFAULT IS 300 (5 min)
    policies:
      - { type: Percent, value: 50, periodSeconds: 60 }
    selectPolicy: Min
```

- **scaleUp** uses the *lowest* recommendation in its window → one spike can't stampede.
- **scaleDown** uses the *highest* → a brief dip can't prematurely shrink you.

The asymmetry is deliberate: **scale out fast, scale in slow.** Scaling in too
eagerly and immediately back out is worse than paying for a few idle Pods.

> This lab sets `scaleDown` to 60s only so the demo doesn't bore you.
> **Leave it at 300 in production.** To never scale down at all:
> `scaleDown: { selectPolicy: Disabled }`.

## HPA + Deployment `replicas`: a real trap

Once an HPA owns a Deployment, **stop setting `replicas` in your manifest.**

```bash
kubectl apply -f 05-deployment/app-deployment.yaml   # replicas: 3
# HPA immediately scales it back to whatever it wants → a fight on every apply
```

Every `apply` resets replicas to 3, then the HPA corrects it — a pointless
scale-down/scale-up on every deploy. Fixes:

- Omit `replicas` from the Deployment entirely (it defaults to 1 on **create**,
  and is left alone on **update**).
- In Helm, gate it: `{{- if not .Values.autoscaling.enabled }}replicas: {{ .Values.replicaCount }}{{- end }}` (step 14 does this).
- Use Server-Side Apply and let the HPA own the field.

## Troubleshooting

```bash
kubectl describe hpa app-hpa -n $NS          # Events + Conditions, read these first
kubectl get hpa app-hpa -n $NS -o yaml       # full status
kubectl top pods -n $NS                      # is metrics-server even working?
kubectl get apiservice v1beta1.metrics.k8s.io  # should be Available: True
```

| Symptom | Cause |
| ------- | ----- |
| `TARGETS: <unknown>` | metrics-server missing/broken, **or the pod has no `resources.requests`** |
| `Metrics API not available` | metrics-server not installed |
| metrics-server pod not Ready on kind | missing `--kubelet-insecure-tls` |
| `FailedGetResourceMetric` | pod just started — wait a scrape cycle |
| Won't scale past N | `maxReplicas`, or the namespace **ResourceQuota** (step 1) |
| Scales but pods stay Pending | quota or no node capacity — check `describe pod` |
| Flapping | tune `behavior`; raise `stabilizationWindowSeconds` |
| Fights your `kubectl apply` | remove `replicas:` from the Deployment (see above) |

## HPA vs the other autoscalers

| | Scales | Use for |
| - | ------ | ------- |
| **HPA** | pod **count** | stateless request-serving workloads |
| **VPA** | pod **requests/limits** | right-sizing. **Conflicts with HPA on the same metric** |
| **Cluster Autoscaler / Karpenter** | **node** count | when Pods are Pending for lack of capacity |
| **KEDA** | pod count, incl. **to zero** | event-driven work (queues, cron, Kafka) |

HPA and VPA on the same resource will fight. Use VPA in `recommendation` mode
alongside an HPA, or scope them to different metrics.

## Clean up

```bash
kubectl scale deploy/load-generator -n $NS --replicas=0    # stop the load!
kubectl delete -f 11-hpa/app-hpa.yaml -f 11-hpa/load-generator.yaml
# keep metrics-server — kubectl top is too useful to throw away
```

---

**Prev:** [Step 10 — Jobs](../10-jobs/README.md) · **Next:** [Step 12 — Rolling Updates & Rollbacks](../12-rolling-update-rollback/README.md)
