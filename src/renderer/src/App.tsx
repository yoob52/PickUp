import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, Plus } from "lucide-react";
import type {
  CreateTaskInput,
  WorkspaceSnapshot,
} from "../../shared/contracts";
import { TASK_STATUS_LABEL, emptyWorkspaceSnapshot } from "../../shared/task";
export function App() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>(
    emptyWorkspaceSnapshot,
  );
  const [title, setTitle] = useState(""),
    [note, setNote] = useState(""),
    [message, setMessage] = useState("正在读取本地数据…"),
    [busy, setBusy] = useState(false);
  const pending = useRef<CreateTaskInput | null>(null),
    lock = useRef(false),
    sequence = useRef(0);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const seq = ++sequence.current;
      try {
        const result = await window.pickup.getWorkspaceSnapshot();
        if (active && seq === sequence.current) {
          if (result.ok) {
            setSnapshot((current) =>
              result.revision >= current.revision ? result.value : current,
            );
            setMessage("已连接本地数据库");
          } else setMessage(result.message);
        }
      } catch {
        if (active) setMessage("读取失败，请重新打开应用。");
      }
    };
    const unsubscribe = window.pickup.onStateChanged(() => void refresh());
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !title.trim()) return;
    lock.current = true;
    setBusy(true);
    setMessage("正在保存…");
    if (
      !pending.current ||
      pending.current.title !== title.trim() ||
      pending.current.note !== note
    )
      pending.current = {
        commandId: crypto.randomUUID(),
        title: title.trim(),
        note,
      };
    try {
      const result = await window.pickup.createTask(pending.current);
      if (result.ok) {
        pending.current = null;
        setTitle("");
        setNote("");
        setMessage("已收下，保存为待处理。");
        const refreshed = await window.pickup.getWorkspaceSnapshot();
        if (refreshed.ok)
          setSnapshot((current) =>
            refreshed.revision >= current.revision ? refreshed.value : current,
          );
      } else setMessage(result.message);
    } catch {
      setMessage("保存结果待确认，请保留内容并重试。");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <span className="brand">接</span>
        <div>
          <strong>接着 PickUp</strong>
          <small>本地工作助手 · 工程验证版</small>
        </div>
        <span className="badge">OFFLINE FIRST</span>
      </header>
      <section className="heading">
        <p>记下新事，接回未完的事。</p>
        <h1>从记下这一件开始。</h1>
        <p>当前版本用于验证桌面应用与本地保存链路。</p>
      </section>
      <div className="grid">
        <section className="card">
          <h2>
            <Plus size={20} /> 记一件事
          </h2>
          <form onSubmit={submit}>
            <label htmlFor="title">标题</label>
            <input
              id="title"
              autoFocus
              value={title}
              disabled={busy}
              required
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.nativeEvent.isComposing)
                  e.preventDefault();
              }}
              placeholder="下一件需要记住的事"
            />
            <label htmlFor="note">备注（可选）</label>
            <textarea
              id="note"
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
              placeholder="补充背景、链接或下一步"
            />
            <button disabled={busy || !title.trim()}>
              <ArrowDownToLine size={16} />
              {busy ? "正在保存…" : "保存为待处理"}
            </button>
          </form>
          <p role="status">{message}</p>
        </section>
        <section className="list">
          <h2>
            未结束 <span>{snapshot.counts.unfinished}</span>
          </h2>
          {snapshot.unfinished.length === 0 ? (
            <p className="empty">还没有事项，从左侧记下第一件。</p>
          ) : (
            <ul>
              {snapshot.unfinished.map((task) => (
                <li key={task.id}>
                  <strong>{task.title}</strong>
                  {task.note && <p>{task.note}</p>}
                  <small>{TASK_STATUS_LABEL[task.status]}</small>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
