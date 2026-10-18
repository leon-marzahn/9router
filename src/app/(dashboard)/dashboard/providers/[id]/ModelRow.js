import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";
import { IconButton, StatusDot, Tag } from "@/ui";

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onEdit, onTest, isTesting, onDisable, caps, thinkingSuffix }) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const status = testStatus === "ok" ? "ok" : testStatus === "error" ? "error" : isTesting ? "pending" : "none";
  const copyKey = `model-${model.id}`;
  const showName = !!model.name && model.name !== model.id;

  return (
    <div className="group flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2 transition-colors hover:bg-surface-2/60">
      <span className="mt-1.5 flex shrink-0"><StatusDot status={status} live={isTesting} /></span>
      {/* basis lets the actions wrap onto their own line on a phone instead of
          squeezing the name into a sliver. */}
      <div className="min-w-0 flex-1 basis-48">
        {/* Name first when it says more than the id; the id wraps instead of
            truncating so the full model string stays readable on a phone. */}
        {showName && <div className="break-words text-[13px] leading-snug">{model.name}</div>}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <code className={`min-w-0 break-all font-mono ${showName ? "text-[11px] text-text-muted" : "text-xs"}`}>{displayModel}</code>
          {isCustom && <Tag tone="accent">custom</Tag>}
          {isFree && <Tag tone="success">free</Tag>}
          {alias && alias !== model.id && <Tag className="font-mono">{alias}</Tag>}
          <CapacityBadges caps={caps} colorOverride="text-text-subtle" size={12} />
        </div>
      </div>
      <div className="-my-1 ml-auto flex shrink-0 items-center justify-end gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
        {onTest && (
          <IconButton
            icon={isTesting ? "progress_activity" : "science"}
            label={isTesting ? "Testing…" : "Test model"}
            onClick={onTest}
            disabled={isTesting}
            className={isTesting ? "[&_.material-symbols-outlined]:animate-spin" : undefined}
          />
        )}
        <IconButton
          icon={copied === copyKey ? "check" : "content_copy"}
          label={copied === copyKey ? "Copied" : "Copy model id"}
          onClick={() => onCopy(displayModel, copyKey)}
          className={copied === copyKey ? "text-success-text" : undefined}
        />
        {isCustom && onEdit && <IconButton icon="edit" label="Edit custom model" onClick={onEdit} />}
        {isCustom ? (
          <IconButton icon="close" label="Remove custom model" onClick={onDeleteAlias} className="hover:bg-danger-soft hover:text-danger-text" />
        ) : onDisable ? (
          <IconButton icon="block" label="Disable this model" onClick={onDisable} className="hover:bg-danger-soft hover:text-danger-text" />
        ) : null}
      </div>
    </div>
  );
}

ModelRow.propTypes = {
  model: PropTypes.shape({
    id: PropTypes.string.isRequired,
  }).isRequired,
  fullModel: PropTypes.string.isRequired,
  alias: PropTypes.string,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  testStatus: PropTypes.oneOf(["ok", "error"]),
  isCustom: PropTypes.bool,
  isFree: PropTypes.bool,
  onDeleteAlias: PropTypes.func,
  onEdit: PropTypes.func,
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
};
