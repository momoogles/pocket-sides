export function renderStepHeader(heading: string, description: string): string {
  return `
    <div class="step-heading">
      <div>
        <h1>${escapeHtml(heading)}</h1>
        <p>${escapeHtml(description)}</p>
      </div>
    </div>`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
