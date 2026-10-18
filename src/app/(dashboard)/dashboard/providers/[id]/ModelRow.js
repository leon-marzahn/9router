import PropTypes from "prop-types";
import { CapacityBadges } from "@/shared/components";
import { IconButton, StatusDot, Tag } from "@/ui";

export default function ModelRow({ model, fullModel, alias, copied, onCopy, testStatus, isCustom, isFree, onDeleteAlias, onTest, isTesting, onDisable, caps, thinkingSuffix }) {
  const displayModel = thinkingSuffix ? `${fullModel}(${thinkingSuffix})` : fullModel;
  const status = testStatus === "ok" ? "ok" : testStatus === "error" ? "error" : isTesting ? "pending" : "none";
  const copyKey = `model-${model.id}`;

  return (
    <div className="group flex min-w-0 items-center gap-3 px-3 py-2 transition-colors hover:bg-surface-2/60">
      <StatusDot status={status} live={isTesting} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate font-mono text-xs">{displayModel}</code>
          {isCustom && <Tag tone="accent">custom</Tag>}
          {isFree && <Tag tone="success">free</Tag>}
          {alias && alias !== model.id && <Tag className="font-mono">{alias}</Tag>}
        </div>
        {(model.name || caps) && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-text-muted">
            {model.name && <span className="truncate">{model.name}</span>}
            <CapacityBadges caps={caps} colorOverride="text-text-subtle" size={12} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-100 transition-opacity sm:opacity-60 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
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
  onTest: PropTypes.func,
  isTesting: PropTypes.bool,
  onDisable: PropTypes.func,
  caps: PropTypes.object,
  thinkingSuffix: PropTypes.string,
};
