import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { parsePatchFiles, type FileDiffMetadata, type FileDiffOptions } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import type { HostContext, ToolResultCard } from "./card-types.js";

type ThemeType = "light" | "dark";

interface PayloadRendererOptions {
  card: ToolResultCard;
  hostContext?: HostContext;
}

interface MountedPayload {
  update(options: PayloadRendererOptions): void;
  unmount(): void;
}

export function mountReviewPayload(
  container: HTMLElement,
  options: PayloadRendererOptions,
): MountedPayload {
  const root = createRoot(container);
  root.render(<ReviewPayload {...options} />);

  return {
    update(nextOptions) {
      root.render(<ReviewPayload {...nextOptions} />);
    },
    unmount() {
      root.unmount();
    },
  };
}

function ReviewPayload({ card, hostContext }: PayloadRendererOptions) {
  const patch = card.payload.patch;
  const themeType: ThemeType = hostContext?.theme === "light" ? "light" : "dark";
  const files = useMemo(() => parseFiles(patch), [patch]);
  const [openFiles, setOpenFiles] = useState(() => new Set<string>());

  return (
    <div className="review-diff">
      <div className="review-page">
        Diff bytes {card.page.offsetBytes}–{card.page.offsetBytes + card.page.lengthBytes} of{" "}
        {card.page.totalBytes}
        {card.page.eof ? " · final page" : " · more pages available"}
      </div>
      {files.length > 0 ? (
        <div className="review-diff-files">
          {files.map((fileDiff, index) => {
            const key = fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}->${fileDiff.name}-${index}`;
            const stats = diffStats(fileDiff);
            const isOpen = openFiles.has(key);

            return (
              <div className="review-diff-file" key={key}>
                <button
                  type="button"
                  className="review-diff-file-header"
                  aria-expanded={isOpen}
                  onClick={() => {
                    setOpenFiles((current) => {
                      const next = new Set(current);
                      if (next.has(key)) {
                        next.delete(key);
                      } else {
                        next.add(key);
                      }
                      return next;
                    });
                  }}
                >
                  <span className="review-diff-file-name">{fileDiff.name}</span>
                  <span className="review-diff-file-stats">
                    <span className="add">+{stats.additions}</span>
                    <span className="remove">-{stats.removals}</span>
                  </span>
                </button>
                {isOpen ? (
                  <FileDiff fileDiff={fileDiff} options={diffOptions(themeType)} className="pierre-diff" />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <pre className="review-raw-diff" aria-label="Diff page contents">{patch}</pre>
      )}
    </div>
  );
}

function parseFiles(patch: string): FileDiffMetadata[] {
  try {
    return parsePatchFiles(patch, "review", true).flatMap((parsedPatch) => parsedPatch.files);
  } catch {
    return [];
  }
}

function diffStats(fileDiff: FileDiffMetadata): { additions: number; removals: number } {
  return fileDiff.hunks.reduce(
    (stats, hunk) => ({
      additions: stats.additions + hunk.additionLines,
      removals: stats.removals + hunk.deletionLines,
    }),
    { additions: 0, removals: 0 },
  );
}

function diffOptions(themeType: ThemeType): FileDiffOptions<undefined> {
  return {
    theme: {
      light: "pierre-light",
      dark: "pierre-dark",
    },
    themeType,
    diffStyle: "unified",
    diffIndicators: "bars",
    hunkSeparators: "line-info",
    lineDiffType: "word-alt",
    overflow: "scroll",
    collapsedContextThreshold: 4,
    expansionLineCount: 20,
    stickyHeader: false,
    disableFileHeader: true,
  };
}
