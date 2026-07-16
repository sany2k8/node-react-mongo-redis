# Step 4 — ReplicaSet

> **Maintains a stable set of running Pods.**

## The idea

Step 2 ended with a deleted Pod and nothing to bring it back. A ReplicaSet fixes
that with the **reconciliation loop** — the single pattern that all of
Kubernetes is built on:

```
        ┌──────────────────────────────────────┐
        │  observe: how many Pods match the    │
        │           selector right now?        │
        └──────────────────┬───────────────────┘
                           ▼
        ┌──────────────────────────────────────┐
        │  compare to desired `replicas`       │
        └──────────────────┬───────────────────┘
                           ▼
        ┌──────────────────────────────────────┐
        │  act: create or delete the delta     │
        └──────────────────┬───────────────────┘
                           └──── repeat forever ────►
```

Nobody tells the ReplicaSet a Pod died. It just notices the count is wrong and
fixes it. **Level-triggered, not edge-triggered** — which is why Kubernetes
self-heals after a controller crash, a network partition, or a node loss.

## Apply it

```bash
NS=node-react-mongo-redis
kubectl apply -f 04-replicaset/app-replicaset.yaml

kubectl get rs -n $NS
kubectl get pods -n $NS -l rs-demo=true
```

```console
NAME     DESIRED   CURRENT   READY   AGE
app-rs   3         3         3       10s
```

Note the Pod names: `app-rs-x7k2p` — the RS generates a random suffix. Pods from
a ReplicaSet are **cattle, not pets**. They have no stable identity, no stable
IP, no stable storage. (If you need those, you need a StatefulSet — that's what
Mongo would use in a real cluster; see step 9's note.)

## Watch it self-heal

```bash
# terminal 1
kubectl get pods -n $NS -l rs-demo=true -w

# terminal 2 — murder one
kubectl delete pod -n $NS -l rs-demo=true --field-selector=status.phase=Running \
  --dry-run=client -o name | head -1     # pick one
kubectl delete pod <that-pod-name> -n $NS
```

Terminal 1 shows the replacement being created **before the old one finishes
terminating**. Count never dropped to 2 for long. That's the loop working.

## The party trick: steal a Pod with a label

This is the exercise that makes selectors *click*. Ownership is decided purely
by the selector query — so change a Pod's labels and it defects.

```bash
POD=$(kubectl get pods -n $NS -l rs-demo=true -o name | head -1)
echo $POD

# make it no longer match the selector
kubectl label $POD -n $NS rs-demo=false --overwrite

kubectl get rs -n $NS          # DESIRED 3, but it only sees 2 -> creates a 4th
kubectl get pods -n $NS -L rs-demo
```

You now have **4 Pods**: three owned by the RS, and one orphan that nothing
manages. The RS didn't "lose" a Pod — from its point of view the Pod simply
stopped existing, because it stopped matching the query.

This is exactly how you quarantine a misbehaving production Pod for debugging
without downtime: relabel it out of the set, and the controller instantly
replaces it while you keep the broken one alive to inspect.

```bash
# adopt it back — now the RS sees 4 and deletes one to get to 3
kubectl label $POD -n $NS rs-demo=true --overwrite
kubectl get pods -n $NS -l rs-demo=true
```

Look at the orphan's `ownerReferences` before and after:

```bash
kubectl get $POD -n $NS -o jsonpath='{.metadata.ownerReferences}' | python3 -m json.tool
```

## Scaling

```bash
kubectl scale rs app-rs -n $NS --replicas=5
kubectl get rs -n $NS

kubectl scale rs app-rs -n $NS --replicas=2   # scale down
```

Which Pods get killed on scale-down? Kubernetes ranks by a
**deletion cost heuristic**: unscheduled first, then Pending, then unready,
then Pods on nodes with more replicas, then newest first. You can override it
per-Pod:

```bash
kubectl annotate pod <pod> -n $NS controller.kubernetes.io/pod-deletion-cost=-100
# lower cost = deleted first
```

## Why you should not use ReplicaSets directly

Try to change the image:

```bash
kubectl set image rs/app-rs app=sany2k8/node-react-mongo-redis-app:v2 -n $NS
kubectl get pods -n $NS -l rs-demo=true -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{end}'
```

**Every Pod still runs v1.** The RS template changed, but a ReplicaSet has *no
update strategy* — it only reconciles the *count*, never the *content* of
existing Pods. New Pods would get v2; existing ones are never touched.

To actually roll it out you'd have to delete every Pod by hand and eat the
downtime. **That gap is precisely what a Deployment fills** — it manages
ReplicaSets and orchestrates the transition between them. Which is step 5.

## Clean up

```bash
# deleting an RS cascades to its Pods via ownerReferences
kubectl delete rs app-rs -n $NS

# orphan the Pods instead of deleting them
kubectl delete rs app-rs -n $NS --cascade=orphan
```

---

**Prev:** [Step 3 — Labels & Selectors](../03-labels-selectors/README.md) · **Next:** [Step 5 — Deployment](../05-deployment/README.md)
