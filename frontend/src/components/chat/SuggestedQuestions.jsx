export default function SuggestedQuestions({ questions, onPick }) {
  return (
    <div className="flex flex-wrap gap-2 border-t border-surface-border bg-white px-3 pt-3">
      {questions.map((q) => (
        <button
          key={q}
          onClick={() => onPick(q)}
          className="rounded-full border border-surface-border bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-600 hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700"
        >
          {q}
        </button>
      ))}
    </div>
  );
}
