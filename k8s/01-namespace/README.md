# Step 1 — Namespace

> **Isolated resource workspaces.**

## The idea

A Namespace is a **name-scoping boundary**, not a machine boundary. Pods from
different namespaces still run on the same nodes and — by default — can still
talk to each other over the network. What a namespace gives you is:

| Gives you                        | Does **not** give you                    |
| -------------------------------- | ---------------------------------------- |
| Unique names per namespace       | Network isolation (needs NetworkPolicy)  |
| A scope for quotas & limits      | Node isolation                           |
| A scope for RBAC permissions     | Security boundary against a root escape  |
| One-command teardown             | Isolation for cluster-wide objects       |

Some objects are **cluster-scoped** and ignore namespaces entirely — Nodes,
PersistentVolumes (step 9), StorageClasses, and Namespaces themselves.

```bash
# Which resources are namespaced and which are not?
kubectl api-resources --namespaced=true  | head
kubectl api-resources --namespaced=false | head
```

## Apply it

```bash
kubectl apply -f 01-namespace/namespace.yaml
```

This file creates three objects:

1. **Namespace** `node-react-mongo-redis` — the workspace itself.
2. **ResourceQuota** — a hard cap on CPU/memory/pods/PVCs for the whole namespace.
3. **LimitRange** — default requests/limits for containers that don't set their own.

> **Why the quota and limit range matter together:** a ResourceQuota on
> `requests.cpu` makes requests *mandatory* — any Pod without them is rejected.
> The LimitRange quietly supplies defaults so you don't have to annotate every
> early lesson. This pairing is exactly how real multi-tenant clusters are run.

## Verify

```bash
kubectl get namespace node-react-mongo-redis
kubectl describe namespace node-react-mongo-redis   # shows quota + limits
kubectl get resourcequota,limitrange -n node-react-mongo-redis
```

`describe` prints a live **Used vs Hard** table — come back to it after step 11
(HPA) and watch `pods` and `requests.cpu` climb.

## Save yourself typing

Every command from here on needs `-n node-react-mongo-redis`. Pin it once instead:

```bash
kubectl config set-context --current --namespace=node-react-mongo-redis

# confirm
kubectl config view --minify | grep namespace:
```

The manifests still carry an explicit `namespace:` in their metadata, so they
land in the right place no matter what your context says. That is deliberate —
**a manifest that depends on your current context is a manifest that will one
day be applied to prod by accident.**

## Try this

```bash
# Namespaces are just objects — select them by label like anything else
kubectl get ns -l lab=k8s-mastery

# Prove name scoping: this "app-pod" name is free in every other namespace
kubectl get pods --all-namespaces | grep app-pod

# See the quota consume as you go (nothing yet — it's empty)
kubectl describe resourcequota lab-quota -n node-react-mongo-redis
```

## Teardown

The whole point of the namespace. This deletes **everything** in the lab —
Deployments, Services, PVCs, the lot:

```bash
kubectl delete namespace node-react-mongo-redis
```

> Deletion is asynchronous and cascades to every object inside. If a namespace
> hangs in `Terminating`, something has a finalizer that won't release —
> `kubectl get all -n <ns>` and `kubectl api-resources --verbs=list --namespaced -o name | xargs -n1 kubectl get -n <ns> --show-kind --ignore-not-found` will find it.

---

**Next:** [Step 2 — Pod](../02-pod/README.md)
