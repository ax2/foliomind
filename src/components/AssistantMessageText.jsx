import { lazy, memo, Suspense } from "react";

const MarkdownMessage = lazy(() => import("./MarkdownMessage.jsx"));

export const AssistantMessageText = memo(function AssistantMessageText({ text, streaming = false }) {
  const content = String(text ?? "");
  if (streaming) return <p className="assistant-stream-text">{content}</p>;
  return (
    <Suspense fallback={<p className="assistant-stream-text">{content}</p>}>
      <MarkdownMessage text={content} />
    </Suspense>
  );
});
