const REVIEW_ACTIONS = new Set([
  "confirm_fact", "exclude_fact", "correct_fact", "confirm_entry", "revoke_entry",
  "add_factual_note", "add_relationship_note",
]);

function cleanText(value, max = 8000) {
  return String(value || "").trim().slice(0, max);
}

function removeFirst(text, target) {
  const index = text.indexOf(target);
  if (index < 0) return null;
  return `${text.slice(0, index)}${text.slice(index + target.length)}`
    .replace(/\n{3,}/g, "\n\n").trim();
}

function applyDiaryReview(entry, { action, issueIndex, replacementText, restoredIssues = [] }) {
  if (!REVIEW_ACTIONS.has(action)) throw Object.assign(new Error("Unsupported diary review action"), { status: 400 });
  const issues = Array.isArray(entry.validation_issues) ? entry.validation_issues : [];
  let nextIssues = issues;
  let bodyMarkdown = String(entry.body_markdown || "");
  let issue = null;

  if (["confirm_fact", "exclude_fact", "correct_fact"].includes(action)) {
    if (!Number.isInteger(issueIndex) || issueIndex < 0 || issueIndex >= issues.length) {
      throw Object.assign(new Error("Choose a valid red-point item"), { status: 400 });
    }
    issue = issues[issueIndex];
    nextIssues = issues.filter((_, index) => index !== issueIndex);
  }

  if (action === "exclude_fact") {
    const claim = cleanText(issue?.text, 3000);
    const removed = claim ? removeFirst(bodyMarkdown, claim) : null;
    bodyMarkdown = removed !== null
      ? removed
      : `${bodyMarkdown}\n\n> 妤妤后来确认：上面关于“${claim || "这一项"}”的说法不成立。`.trim();
  }

  if (action === "correct_fact") {
    const replacement = cleanText(replacementText, 3000);
    if (!replacement) throw Object.assign(new Error("Please write the corrected content"), { status: 400 });
    const claim = cleanText(issue?.text, 3000);
    bodyMarkdown = claim && bodyMarkdown.includes(claim)
      ? bodyMarkdown.replace(claim, replacement)
      : `${bodyMarkdown}\n\n> 妤妤后来纠正：${replacement}`.trim();
  }

  if (action === "confirm_entry") nextIssues = [];
  if (action === "revoke_entry") {
    nextIssues = [...restoredIssues.filter((item) => item?.kind !== "manual_retraction"), {
      kind: "manual_retraction", itemIndex: null, text: "",
      reasons: ["妤妤撤回了整篇确认；这篇日记暂时不进入事实检索。"],
    }];
  }

  const changesEntry = ["confirm_fact", "exclude_fact", "correct_fact", "confirm_entry", "revoke_entry"].includes(action);
  return {
    changesEntry,
    bodyMarkdown,
    validationIssues: nextIssues,
    status: nextIssues.length ? "needs_review" : "confirmed",
    issue,
  };
}

function reviewEventForAction(action) {
  return ({
    confirm_fact: "fact_confirmed",
    exclude_fact: "fact_excluded",
    correct_fact: "fact_corrected",
    confirm_entry: "entry_confirmed",
    revoke_entry: "entry_confirmation_revoked",
    add_factual_note: "factual_note_added",
    add_relationship_note: "relationship_note_added",
  })[action];
}

module.exports = { REVIEW_ACTIONS, applyDiaryReview, cleanText, reviewEventForAction };
