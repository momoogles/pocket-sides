import { escapeHtml } from "./escapeHtml";

export function renderStepHeader(heading: string, description: string): string {
  return `
    <div class="step-heading">
      <div>
        <h1>${escapeHtml(heading)}</h1>
        <p>${escapeHtml(description)}</p>
      </div>
    </div>`;
}
