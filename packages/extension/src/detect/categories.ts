export interface CategoryInfo {
  name: string;
  groups: number[];
  priority: number;
}

export type RawCategories = Record<string, CategoryInfo>;

/** Map of category ID → name, loaded from categories.json */
export class CategoryMap {
  private categories: Map<number, CategoryInfo>;

  constructor(raw: RawCategories) {
    this.categories = new Map();
    for (const [id, info] of Object.entries(raw)) {
      this.categories.set(parseInt(id, 10), info);
    }
  }

  getName(id: number): string {
    return this.categories.get(id)?.name ?? `Unknown (${id})`;
  }

  getInfo(id: number): CategoryInfo | undefined {
    return this.categories.get(id);
  }

  has(id: number): boolean {
    return this.categories.has(id);
  }
}
