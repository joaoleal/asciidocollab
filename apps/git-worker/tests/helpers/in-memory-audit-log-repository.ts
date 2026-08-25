import type {
  AuditLog,
  AuditLogFilters,
  AuditLogRepository,
  PaginationOptions,
  PagedResult,
  ProjectId,
  UserId,
} from '@asciidocollab/domain';

/**
 * A local, minimal in-memory `AuditLogRepository` fake for this app's run-loop tests. See
 * `in-memory-git-operation-repository.ts`'s class docs for why this app keeps its own fakes
 * rather than reusing `packages/domain/tests`' — the same `src`/`dist` module-identity mismatch
 * applies here too.
 */
export class InMemoryAuditLogRepository implements AuditLogRepository {
  private readonly storage: AuditLog[] = [];

  async save(auditLog: AuditLog): Promise<void> {
    this.storage.push(auditLog);
  }

  async findByProjectId(projectId: ProjectId): Promise<AuditLog[]> {
    return this.storage.filter((log) => log.projectId?.value === projectId.value);
  }

  async findByUserId(userId: UserId): Promise<AuditLog[]> {
    return this.storage.filter((log) => log.userId?.value === userId.value);
  }

  async findAll(): Promise<AuditLog[]> {
    return [...this.storage];
  }

  async findWithFilters(filters: AuditLogFilters, pagination: PaginationOptions): Promise<PagedResult<AuditLog>> {
    let items = [...this.storage];
    if (filters.fromDate) items = items.filter((log) => log.timestamp >= filters.fromDate!);
    if (filters.toDate) items = items.filter((log) => log.timestamp <= filters.toDate!);
    if (filters.userId) items = items.filter((log) => log.userId?.value === filters.userId);
    if (filters.actionType) items = items.filter((log) => log.action === filters.actionType);

    const total = items.length;
    const start = (pagination.page - 1) * pagination.limit;
    return { items: items.slice(start, start + pagination.limit), total, page: pagination.page, limit: pagination.limit };
  }

  async findDistinctActionTypes(): Promise<string[]> {
    return [...new Set(this.storage.map((log) => log.action))];
  }
}
