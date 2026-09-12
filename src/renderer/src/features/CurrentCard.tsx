import { Check, ListStart, Maximize2, Pause, Plus } from "lucide-react";
import type { TaskSummary } from "../../../shared/contracts";
import { nextStepText } from "../lib/format";
import { Button, IconButton } from "../ui/primitives";

type Props = {
  current: TaskSummary | null;
  onCapture: () => void;
  onChoose: () => void;
  onPause: () => void;
  onComplete: () => void;
  onDetail: () => void;
};

export function CurrentCard({
  current,
  onCapture,
  onChoose,
  onPause,
  onComplete,
  onDetail,
}: Props) {
  if (!current) {
    return (
      <article className="current-card">
        <div className="card-topline">
          <div className="card-kicker">NOW / OPEN SLOT</div>
          <div className="card-id">F02 / CURRENT</div>
        </div>
        <div className="current-content">
          <h2>现在准备做什么？</h2>
          <p className="next-line">
            选择一件未结束的事开始，或者先把新事项收进来。
          </p>
        </div>
        <div className="current-actions">
          <Button icon={<ListStart size={15} />} onClick={onChoose}>
            选择任务
          </Button>
          <Button
            kind="secondary"
            icon={<Plus size={15} />}
            onClick={onCapture}
          >
            记一件事
          </Button>
        </div>
      </article>
    );
  }

  const next = nextStepText(current);

  return (
    <article className="current-card">
      <div className="card-topline">
        <div className="card-kicker">CURRENT / IN PROGRESS</div>
        <div className="card-id">F02 / LIVE</div>
      </div>
      <div className="current-content">
        <h2>{current.title}</h2>
        <p className="next-line">
          <strong>下一步：</strong>
          {next || "还没有保存断点。完成一小步，再回来留下一句。"}
        </p>
      </div>
      <div className="current-actions">
        <Button kind="secondary" icon={<Pause size={15} />} onClick={onPause}>
          暂停并留线索
        </Button>
        <Button
          kind="secondary"
          icon={<Check size={15} />}
          onClick={onComplete}
        >
          完成
        </Button>
        <IconButton label="查看当前任务详情" onClick={onDetail}>
          <Maximize2 size={16} />
        </IconButton>
      </div>
    </article>
  );
}
