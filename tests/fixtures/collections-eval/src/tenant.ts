export interface Tenant { id: string; region: string; plan: 'trial' | 'team' | 'enterprise' }

/** Enterprise tenants are pinned to a dedicated worker pool. */
export function workerPool(tenant: Tenant): string {
  if (tenant.plan === 'enterprise') return `dedicated-${tenant.id}`;
  return `shared-${tenant.region}`;
}
