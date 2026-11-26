// An EditorStore over plain arrays. The local engine saves `data` as JSON
// after each change; tests use it as is. No node imports.
import type { ProjectSources } from "./project";
import type { ClipRow, DecisionRow, EditRow, EditorStore, GraphicRow, JobInfo, RenderRow, VersionRow, VideoJobType } from "./state";

export interface LocalJob {
  id: string; type: VideoJobType; owner: string; payload: Record<string, string>; amount?: number;
  status: "queued" | "running" | "done" | "failed"; progress?: unknown; error?: string; createdAt: number;
}

export interface EditorData {
  seq: number;
  clips: ClipRow[]; edits: EditRow[]; versions: VersionRow[]; decisions: DecisionRow[];
  graphics: GraphicRow[]; renders: RenderRow[]; jobs: LocalJob[];
  /** Web projects fetched from the cloud, last copy each (./local). */
  projects?: Record<string, ProjectSources>;
}

export const emptyData = (): EditorData => ({ seq: 0, clips: [], edits: [], versions: [], decisions: [], graphics: [], renders: [], jobs: [] });

const clean = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

export function memoryStore(data: EditorData = emptyData(), changed: () => void = () => {}) {
  const id = (table: string) => `${table}_${(++data.seq).toString(36).padStart(6, "0")}`;
  // Rows go out as copies, so a caller cannot change state behind the rules.
  const out = <T extends object>(row: T | undefined) => row ? clean(row) : null;
  const byId = <T extends { id: string }>(rows: T[], key: string) => rows.find(r => r.id === key);
  function insert<T extends { id: string }>(rows: T[], table: string, row: Omit<T, "id">) {
    const key = id(table);
    rows.push(clean({ ...row, id: key } as T));
    changed();
    return key;
  }
  /** An undefined value clears the field. */
  function update<T extends { id: string }>(rows: T[], key: string, fields: object) {
    const row = byId(rows, key) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`no row ${key}`);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) delete row[k];
      else row[k] = clean(v as object);
    }
    changed();
  }

  const store: EditorStore = {
    clip: async (owner, hash) => out(data.clips.find(c => c.owner === owner && c.hash === hash)),
    clips: async owner => data.clips.filter(c => c.owner === owner).map(clean),
    insertClip: async row => insert(data.clips, "clip", row),
    patchClip: async (key, fields) => update(data.clips, key, fields),
    edit: async key => out(byId(data.edits, key)),
    insertEdit: async row => insert(data.edits, "edit", row),
    patchEdit: async (key, fields) => update(data.edits, key, fields),
    insertVersion: async row => { data.versions.push(clean(row)); changed(); },
    insertDecision: async row => { data.decisions.push(clean(row)); changed(); },
    decisions: async (editId, limit) => data.decisions.filter(d => d.editId === editId).reverse().slice(0, limit).map(clean),
    graphic: async key => out(byId(data.graphics, key)),
    graphicByAsset: async (owner, assetId) => out(data.graphics.find(g => g.owner === owner && g.assetId === assetId)),
    graphics: async editId => data.graphics.filter(g => g.editId === editId).map(clean),
    insertGraphic: async row => insert(data.graphics, "graphic", row),
    patchGraphic: async (key, fields) => update(data.graphics, key, fields),
    render: async key => out(byId(data.renders, key)),
    renders: async (editId, limit) => data.renders.filter(r => r.editId === editId).reverse().slice(0, limit).map(clean),
    insertRender: async row => insert(data.renders, "render", row),
    patchRender: async (key, fields) => update(data.renders, key, fields),
    job: async key => {
      const job = byId(data.jobs, key);
      return job ? clean({ status: job.status, progress: job.progress }) as JobInfo : null;
    },
  };

  return {
    store, data,
    /** Queue a job row; the caller runs it. */
    addJob(job: Pick<LocalJob, "type" | "owner" | "payload" | "amount">) {
      return insert(data.jobs, "job", { ...job, status: "queued", createdAt: Date.now() });
    },
    patchJob: (key: string, fields: Partial<LocalJob>) => update(data.jobs, key, fields),
    getJob: (key: string) => byId(data.jobs, key) ?? null,
  };
}
