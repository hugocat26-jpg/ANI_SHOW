import type { Task, TaskStatus, TaskType } from '../domain/types.ts'
import type { LeadMinerRepository } from '../data/repository.ts'

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export class TaskOrchestrator {
  private tasks = new Map<string, Task>()
  private repository?: LeadMinerRepository

  constructor(repository?: LeadMinerRepository) {
    this.repository = repository
  }

  create(type: TaskType, input: unknown, platformKey?: string): Task {
    const now = new Date().toISOString()
    const task: Task = {
      id: createId(type),
      type,
      status: 'pending',
      platformKey,
      progress: 0,
      input,
      createdAt: now,
      updatedAt: now
    }
    this.tasks.set(task.id, task)
    this.repository?.saveTask(task)
    return task
  }

  transition(id: string, status: TaskStatus, patch: Partial<Task> = {}): Task {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`Task not found: ${id}`)
    const updated = { ...task, ...patch, status, updatedAt: new Date().toISOString() }
    this.tasks.set(id, updated)
    this.repository?.saveTask(updated)
    return updated
  }

  list(): Task[] {
    const persisted = this.repository?.listTasks()
    if (persisted && persisted.length > 0) return persisted
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}
