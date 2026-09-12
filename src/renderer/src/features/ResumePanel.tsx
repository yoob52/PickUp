import { ArrowUpRight, Play } from "lucide-react";
import type { TaskSummary, WorkspaceSnapshot } from "../../../shared/contracts";
import { formatDateTime, nextStepText } from "../lib/format";
import { Button } from "../ui/primitives";
import { EmptyState } from "../ui/primitives";

type Props = {
  snapshot: WorkspaceSnapshot;
  highlight: boolean;
  onContinue: (task: TaskSummary) => void;
  onChooseOther: () => void;
  onDefer: () => void;
  onPickNext: () => void;
  onChangeNext: () => void;
};

export function ResumePanel({
  snapshot,
  highlight,
  onContinue,
  onChooseOther,
  onDefer,
  onPickNext,
  onChangeNext,
}: Props) {
  const resume = snapshot.resume;
  const todo = snapshot.unfinished.find((task) => task.status === "todo");

  return (
    <article className="recovery-panel">
      <div className="section-head">
        <div>
          <h3>恢复区域</h3>
          <span className="section-meta">Recovery / next move</span>
        </div>
      </div>
      <div className="recovery-body">
        {resume ? (
          <div>
            <p className="recovery-intro">
              {highlight
                ? "当前这件事已经放下。推荐最近暂停的工作，不会自动开始。"
                : "最近暂停的事项会先出现在这里。推荐只是建议。"}
            </p>
            <div className="recommend-card">
              <div className="recommend-label">Recommended recovery</div>
              <div className="recommend-title">{resume.task.title}</div>
              <div className="recommend-note">
                {nextStepText(resume.task) || "尚未记录断点，可以直接继续。"}
              </div>
              <div className="recommend-meta">
                {formatDateTime(resume.pausedAt)} 暂停
              </div>
              <div className="recommend-actions">
                <Button
                  icon={<ArrowUpRight size={14} />}
                  onClick={() => onContinue(resume.task)}
                >
                  继续这件事
                </Button>
                <Button kind="secondary" onClick={onChooseOther}>
                  选择其他
                </Button>
                {highlight && !snapshot.currentTask ? (
                  <Button kind="ghost" onClick={onDefer}>
                    暂不开始
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : todo ? (
          <div>
            <p className="recovery-intro">
              没有暂停事项。可以从待处理里选一件开始。
            </p>
            <div className="recommend-card">
              <div className="recommend-label">Next available</div>
              <div className="recommend-title">{todo.title}</div>
              <div className="recommend-actions">
                <Button
                  icon={<Play size={14} />}
                  onClick={() => onContinue(todo)}
                >
                  开始
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState>没有需要恢复的事项。当前工作区是空的。</EmptyState>
        )}
        <div className="next-up">
          {snapshot.nextUp ? (
            <>
              <div className="next-up-head">
                <span>Next start</span>
                <button type="button" onClick={onChangeNext}>
                  更换
                </button>
              </div>
              <div className="next-up-item">{snapshot.nextUp.title}</div>
              <p className="next-up-empty">
                这只是下次开工的引用，打开应用不会自动开始。
              </p>
            </>
          ) : (
            <>
              <div className="next-up-head">
                <span>Next start</span>
                <button type="button" onClick={onPickNext}>
                  选择
                </button>
              </div>
              <div className="next-up-empty">
                还没有指定下一次开工的第一件事。
              </div>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
