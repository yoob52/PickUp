import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownRight, ArrowUpRight, Eraser, Plus } from "lucide-react";
import {
  NOTE_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  type CreateTaskInput,
  type Draft,
} from "../../../shared/contracts";
import { createPending, invokeCommand } from "../lib/command";
import { Button, Field } from "../ui/primitives";

type Props = {
  compact?: boolean;
  onCreated: (taskId: string, intent: "later" | "now") => Promise<void> | void;
  onCancel: () => void;
  onNotice: (text: string, tone?: "ok" | "error") => void;
};

export function CaptureForm({ compact, onCreated, onCancel, onNotice }: Props) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [titleError, setTitleError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draftError, setDraftError] = useState("");
  const [draftVersion, setDraftVersion] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);
  const dirty = useRef(false);
  const draftVersionRef = useRef(0);
  const saveGen = useRef(0);
  const timer = useRef(0);
  const pending = useRef(createPending<CreateTaskInput>());
  const lock = useRef(false);
  const intentRef = useRef<"later" | "now">("later");
  const titleState = useRef("");
  const noteState = useRef("");

  useEffect(() => {
    let active = true;
    void window.pickup.getDraft().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setDraftError(result.message);
        return;
      }
      applyDraft(result.value);
    });
    const id = window.setTimeout(() => titleRef.current?.focus(), 30);
    return () => {
      active = false;
      window.clearTimeout(id);
      window.clearTimeout(timer.current);
    };
  }, []);

  function applyDraft(draft: Draft, force = false) {
    draftVersionRef.current = draft.version;
    setDraftVersion(draft.version);
    if (!force && dirty.current) return;
    if (force) dirty.current = false;
    setTitle(draft.title);
    setNote(draft.note);
    titleState.current = draft.title;
    noteState.current = draft.note;
    if (draft.note) setNoteOpen(true);
  }

  function queueDraft(nextTitle: string, nextNote: string) {
    titleState.current = nextTitle;
    noteState.current = nextNote;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void persistDraft(nextTitle, nextNote);
    }, 300);
  }

  async function persistDraft(nextTitle: string, nextNote: string) {
    const gen = ++saveGen.current;
    const expected = draftVersionRef.current;
    try {
      const result = await window.pickup.saveDraft({
        title: nextTitle,
        note: nextNote,
        expectedDraftVersion: expected,
      });
      if (gen !== saveGen.current) return;
      if (result.ok) {
        draftVersionRef.current = result.value.draft.version;
        setDraftVersion(result.value.draft.version);
        setDraftError("");
        return;
      }
      if (result.code === "STATE_CONFLICT") {
        const latest = await window.pickup.getDraft();
        if (gen !== saveGen.current) return;
        if (latest.ok) {
          draftVersionRef.current = latest.value.version;
          setDraftVersion(latest.value.version);
          setDraftError("草稿已在其他窗口更新，当前输入仍保留，可继续编辑。");
        } else setDraftError(result.message);
        return;
      }
      setDraftError(result.message);
    } catch {
      if (gen !== saveGen.current) return;
      setDraftError("草稿尚未保存，关闭前请确认内容仍在。");
    }
  }

  async function flushDraft() {
    window.clearTimeout(timer.current);
    await persistDraft(titleState.current, noteState.current);
  }

  async function clearStoredDraft() {
    window.clearTimeout(timer.current);
    const result = await window.pickup.clearDraft({
      expectedDraftVersion: draftVersionRef.current,
    });
    if (result.ok) {
      applyDraft(result.value.draft, true);
      setNoteOpen(false);
      setTitleError("");
      setDraftError("");
      titleRef.current?.focus();
      return;
    }
    if (result.code === "STATE_CONFLICT") {
      const latest = await window.pickup.getDraft();
      if (latest.ok) applyDraft(latest.value, true);
    }
    setDraftError(result.message);
  }

  async function submit(intent: "later" | "now") {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError("请填写任务标题");
      titleRef.current?.focus();
      return;
    }
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    intentRef.current = intent;
    await flushDraft();
    const input = pending.current.take(
      (commandId) => ({
        commandId,
        title: trimmed,
        note,
        draftVersion: draftVersionRef.current,
      }),
      (current) =>
        current.title === trimmed &&
        current.note === note &&
        current.draftVersion === draftVersionRef.current,
    );
    try {
      const result = await invokeCommand(input.commandId, () =>
        window.pickup.createTask(input),
      );
      if (!result.ok) {
        if (result.code === "VALIDATION_ERROR") setTitleError(result.message);
        else onNotice(result.message, "error");
        return;
      }
      pending.current.clear();
      dirty.current = false;
      setTitle("");
      setNote("");
      titleState.current = "";
      noteState.current = "";
      setTitleError("");
      if (result.value.draftCleared) {
        const latest = await window.pickup.getDraft();
        if (latest.ok) applyDraft(latest.value, true);
      }
      await onCreated(result.value.taskId, intent);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(intentRef.current);
  }

  return (
    <form
      className={compact ? "capture-form compact" : "capture-form"}
      onSubmit={onSubmit}
    >
      <Field id="capture-title" label="标题" error={titleError}>
        <input
          ref={titleRef}
          id="capture-title"
          autoComplete="off"
          autoFocus
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          disabled={busy}
          placeholder="下一件需要记住的事"
          onChange={(event) => {
            dirty.current = true;
            setTitle(event.target.value);
            setTitleError("");
            queueDraft(event.target.value, note);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing)
              event.preventDefault();
          }}
        />
      </Field>
      <div className="field">
        {noteOpen ? (
          <Field id="capture-note" label="备注">
            <textarea
              id="capture-note"
              maxLength={NOTE_MAX_LENGTH}
              value={note}
              disabled={busy}
              placeholder="可选。粘贴链接、文件路径或一句背景"
              onChange={(event) => {
                dirty.current = true;
                setNote(event.target.value);
                queueDraft(title, event.target.value);
              }}
            />
          </Field>
        ) : (
          <button
            type="button"
            className="expand-link"
            onClick={() => setNoteOpen(true)}
          >
            <Plus size={13} />
            展开备注
          </button>
        )}
      </div>
      <p className="helper">
        Enter 保存为待处理。需要立刻接手时，选择“现在处理”。Esc
        或关闭不会创建任务。
      </p>
      {draftError ? (
        <p className="field-error" role="status">
          {draftError}
          <button
            type="button"
            className="expand-link"
            onClick={() => void persistDraft(title, note)}
          >
            重试保存草稿
          </button>
        </p>
      ) : null}
      <div className="modal-actions">
        <Button
          kind="secondary"
          onClick={() => void flushDraft().then(onCancel)}
        >
          关闭
        </Button>
        {title || note ? (
          <Button
            kind="ghost"
            icon={<Eraser size={14} />}
            onClick={() => void clearStoredDraft()}
            disabled={busy}
          >
            清空草稿
          </Button>
        ) : null}
        <Button
          kind="primary"
          type="submit"
          icon={<ArrowDownRight size={15} />}
          disabled={busy}
          onClick={() => {
            intentRef.current = "later";
          }}
        >
          {busy && intentRef.current === "later" ? "正在保存…" : "稍后处理"}
        </Button>
        <Button
          kind="secondary"
          icon={<ArrowUpRight size={15} />}
          disabled={busy}
          onClick={() => void submit("now")}
        >
          {busy && intentRef.current === "now" ? "正在保存…" : "现在处理"}
        </Button>
      </div>
      <span className="sr-only">草稿版本 {draftVersion}</span>
    </form>
  );
}
