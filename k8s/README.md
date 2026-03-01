# Kubernetes Deployment

## 1. Update secrets and image

Edit:
- `secret.yaml` (`SESSION_SECRET`, `DEFAULT_ROOT_PASSWORD`)
- `deployment.yaml` image (if not using `ghcr.io/amtvzw/cp-ops:latest`)

## 2. Apply base resources

```bash
kubectl apply -k k8s
```

## 3. Optional ingress

Edit host in `ingress-optional.yaml`, then apply:

```bash
kubectl apply -f k8s/ingress-optional.yaml -n cp-ops
```

## 4. Optional Redis

If you enable Redis-backed rate limiting, set `REDIS_URL` in `configmap.yaml` and apply:

```bash
kubectl apply -f k8s/redis-optional.yaml -n cp-ops
kubectl rollout restart deployment/cp-ops -n cp-ops
```
