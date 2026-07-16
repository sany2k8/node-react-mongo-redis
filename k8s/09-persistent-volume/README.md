# Step 9 — PersistentVolume & PersistentVolumeClaim

> **Durable state storage.**

## The idea

Step 8 ended with your database having amnesia: `docs=0`, because the Mongo Pod
was recreated and its `emptyDir` went with it. Containers are ephemeral —
that's the deal. Persistence has to come from outside the Pod.

```
   Pod
    │  volumes: { persistentVolumeClaim: { claimName: mongo-data } }
    ▼
   PVC "mongo-data"          "I want 1Gi, RWO, class=standard"   (namespaced)
    │  bound by the control plane
    ▼
   PV  "pvc-53105f29-..."    the actual provisioned volume       (CLUSTER-scoped)
    │
    ▼
   StorageClass "standard"   rancher.io/local-path → a dir on the node
```

The Pod never names a disk. It names a **claim**. That indirection is why the
same YAML runs on kind, EKS (EBS), and GKE (PD) — only the StorageClass differs.

| Object | Scope | Written by |
| ------ | ----- | ---------- |
| **PVC** | namespaced | **you** |
| **PV** | **cluster** | usually the StorageClass, dynamically |
| **StorageClass** | cluster | the cluster admin |

## What this cluster gives you

```bash
kubectl get storageclass
```

```console
NAME                 PROVISIONER             RECLAIMPOLICY   VOLUMEBINDINGMODE
hostpath             rancher.io/local-path   Delete          WaitForFirstConsumer
standard (default)   rancher.io/local-path   Delete          WaitForFirstConsumer
```

Two things to notice, both of which matter:

- **`RECLAIMPOLICY: Delete`** — delete the PVC and **your data is destroyed**.
  Fine for a lab, alarming for a real database. See the reclaim section below.
- **`VOLUMEBINDINGMODE: WaitForFirstConsumer`** — the PV isn't created until a
  Pod actually needs it, so the volume gets provisioned on the *same node* the
  Pod was scheduled to. With `Immediate` binding, the volume could land on node A
  while the scheduler wants the Pod on node B — deadlock.

## Apply it

```bash
NS=node-react-mongo-redis
kubectl apply -f 09-persistent-volume/mongo-pvc.yaml -f 09-persistent-volume/redis-pvc.yaml

kubectl get pvc -n $NS
```

```console
NAME         STATUS    VOLUME   CAPACITY   STORAGECLASS
mongo-data   Pending                       standard      <-- Pending is CORRECT
redis-data   Pending                       standard
```

**`Pending` is not an error here.** That's `WaitForFirstConsumer` doing its job —
no Pod has claimed it yet. `kubectl describe pvc mongo-data -n $NS` says so:
`waiting for first consumer to be created before binding`.

Now give it a consumer:

```bash
kubectl apply -f 09-persistent-volume/mongo-deployment.yaml -f 09-persistent-volume/redis-deployment.yaml
kubectl rollout status deploy/mongo -n $NS
kubectl rollout status deploy/redis -n $NS

kubectl get pvc,pv -n $NS
```

```console
NAME         STATUS   VOLUME                                     CAPACITY   STORAGECLASS
mongo-data   Bound    pvc-53105f29-c779-408e-98e1-11b6376aed84   1Gi        standard
redis-data   Bound    pvc-a0add312-6acc-4574-b88d-efb6516e1f65   512Mi      standard
```

A PV you never wrote now exists. That's dynamic provisioning.

The **only** change from step 8 is in `volumes:`:

```diff
  volumes:
    - name: data
-     emptyDir: {}
+     persistentVolumeClaim:
+       claimName: mongo-data
```

## 💀 Prove it — kill the database

```bash
# write something
kubectl port-forward -n $NS svc/app 8080:80 &
curl -s -X POST localhost:8080/api/items -H 'Content-Type: application/json' \
  -d '{"name":"survives-pod-death"}'
curl -s localhost:8080/api/counter    # 1
curl -s localhost:8080/api/counter    # 2
curl -s localhost:8080/api/counter    # 3
kill %1

# destroy both databases
kubectl delete pod -n $NS -l component=mongo
kubectl delete pod -n $NS -l component=redis
kubectl rollout status deploy/mongo -n $NS
kubectl rollout status deploy/redis -n $NS

# and look
kubectl port-forward -n $NS svc/app 8080:80 &
curl -s localhost:8080/api/items
curl -s localhost:8080/api/counter
kill %1
```

```jsonc
[{"_id":"6a590283...","name":"survives-pod-death","created_at":"..."}]   // ✓ alive
{"source":"redis","hit_counter":4}                                        // ✓ resumed at 4, not 1
```

Both databases were destroyed and rebuilt from scratch, and the data is intact.
Redis picking up at **4** rather than 1 proves the AOF (`--appendonly yes`, on
the PVC) was replayed. Re-run step 8's `emptyDir` version and the same test
gives you `[]` and `1`.

## Reclaim policy — how you lose your data

```bash
kubectl get pv | grep node-react
# ... RECLAIM POLICY: Delete ...
```

| Policy | On PVC deletion |
| ------ | --------------- |
| **Delete** | PV **and the underlying disk** are destroyed. Default for most dynamic classes. |
| **Retain** | PV survives as `Released`. Data intact, needs manual cleanup to reuse. |

`kubectl delete pvc mongo-data` on a `Delete`-policy class is an **irreversible
data loss command**. Protect a real database by flipping the live PV to Retain:

```bash
PV=$(kubectl get pvc mongo-data -n $NS -o jsonpath='{.spec.volumeName}')
kubectl patch pv $PV -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

PVCs in use are also protected by the `kubernetes.io/pvc-protection` finalizer —
delete one while a Pod mounts it and it sits in `Terminating` until the Pod goes.
That's a safety net, not a strategy.

## Static provisioning (the side demo)

```bash
kubectl apply -f 09-persistent-volume/manual-pv.yaml
kubectl get pv manual-demo-pv
kubectl get pvc manual-demo-pvc -n $NS
```

```console
NAME              STATUS   VOLUME           CAPACITY
manual-demo-pvc   Bound    manual-demo-pv   100Mi      <-- asked for 50Mi!
```

**A PVC gets the whole PV.** It requested 50Mi and bound to the 100Mi volume —
the extra 50Mi isn't given back or shared. Binding is *matchmaking*, not
carving. A PVC binds to a PV that is *at least* as big, with compatible access
modes and a matching `storageClassName`.

Note `storageClassName: ""` on both. Empty string means *"no class"* and is what
lets the static PV match. Omit the field entirely and the **default** class
hijacks the claim and dynamically provisions something else.

## Access modes

| Mode | Short | Meaning |
| ---- | ----- | ------- |
| ReadWriteOnce | RWO | read-write by **one node** |
| ReadOnlyMany | ROX | read-only by many nodes |
| ReadWriteMany | RWX | read-write by many nodes |
| ReadWriteOncePod | RWOP | read-write by exactly **one Pod** (k8s 1.29+) |

> **RWO means one NODE, not one Pod.** Several Pods on the *same* node can share
> an RWO volume — which is exactly how a RollingUpdate can silently corrupt a
> database if both Pods land together. `ReadWriteOncePod` is the real mutex.

Block storage (EBS, PD, local-path) is RWO. RWX needs a network filesystem —
NFS, EFS, CephFS, Azure Files.

## ⚠️ Why this is still the wrong way to run a database

This lab uses a **Deployment + PVC** because that's what the curriculum is
teaching. For a real stateful workload it's wrong, and here's precisely why:

| Problem | Deployment + PVC | StatefulSet |
| ------- | ---------------- | ----------- |
| Pod identity | random suffix, changes every restart | stable ordinal: `mongo-0`, `mongo-1` |
| Storage per replica | **all replicas share ONE PVC** | `volumeClaimTemplates` — one PVC each |
| Scale to 3 | 3 Pods fighting over 1 RWO volume → corruption | 3 Pods, 3 volumes, clean |
| Startup order | all at once | ordered `0 → 1 → 2` (replica set init) |
| DNS | one Service VIP | `mongo-0.mongo.ns.svc` per Pod |

Try `kubectl scale deploy/mongo --replicas=3` and the second and third Pods
either wedge in `ContainerCreating` (cloud, Multi-Attach error) or — worse, on
single-node local storage — start up and **corrupt each other's data files**.

`strategy: Recreate` in these manifests is what stops the *rolling update* case
of that. It is a workaround, not a fix. **The fix is a StatefulSet.**

## Debugging

```bash
kubectl describe pvc mongo-data -n $NS       # binding events live here
kubectl describe pv <pv-name>
kubectl get events -n $NS --field-selector involvedObject.kind=PersistentVolumeClaim

# where did local-path actually put the bytes?
kubectl get pv <pv-name> -o jsonpath='{.spec.local.path}'; echo

# inspect the volume from inside
kubectl exec deploy/mongo -n $NS -- ls -la /data/db
kubectl exec deploy/mongo -n $NS -- df -h /data/db
```

| Symptom | Cause |
| ------- | ----- |
| PVC `Pending` forever | `WaitForFirstConsumer` + no Pod, **or** no StorageClass, **or** no PV matches |
| `Multi-Attach error` | RWO volume, two Pods, two nodes → use `Recreate`/StatefulSet |
| Pod `ContainerCreating` forever | mount failing — read `describe pod` events |
| Data vanished | you were on `emptyDir`, or the PVC was deleted under a `Delete` class |
| PVC won't delete | `pvc-protection` finalizer — a Pod still mounts it |

## Clean up (the demo only — keep the real PVCs)

```bash
kubectl delete -f 09-persistent-volume/manual-pv.yaml

# Retain policy means the PV survives as "Released" — clean it up by hand
kubectl get pv manual-demo-pv
kubectl delete pv manual-demo-pv
```

---

**Prev:** [Step 8 — ConfigMap & Secret](../08-configmap-secret/README.md) · **Next:** [Step 10 — Jobs](../10-jobs/README.md)
