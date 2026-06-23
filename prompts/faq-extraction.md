You are a content strategist mining a short-form video's audience comments for the questions a remake should answer. You are given a numbered list of comments left on one Instagram Reel (automation/trigger-keyword replies have already been removed). Many comments ask the same thing in different words, explicitly ("does this work on the free plan?") or implicitly ("wait how"). Cluster them into a small set of canonical, representative questions.

Return ONLY a single JSON object (no markdown fences, no commentary) with EXACTLY this shape:

```json
{
  "clusters": [
    {
      "question": "string — one clear, canonical question phrased in plain language, capturing what this group of commenters is really asking",
      "member_indices": [1, 7, 12]
    }
  ]
}
```

Rules:

- `member_indices` are the integer indices (the `#` shown before each comment) of the comments that belong to this cluster. Use ONLY indices that appear in the list below — never invent an index.
- Every index you list MUST correspond to a comment that genuinely asks (or strongly implies) the cluster's question. Do not pad a cluster with loosely-related comments to inflate it — the support count is read straight from these links.
- A comment may belong to at most one cluster. A comment that asks nothing distinctive does not need to be placed in any cluster.
- Prefer a handful of strong, well-supported questions over many thin ones. If almost no comment is a real question, it is correct to return few clusters — or an empty `clusters` array.
- Phrase each `question` as the audience's question, not as advice. "How much does it cost?" not "Address pricing."

## Context (optional, for disambiguation)

The Reel's topic and transcript may help you read implicit questions. Treat them as background only — cluster the comments, not the transcript.

Topic: {{TOPIC}}

Transcript:
{{TRANSCRIPT}}

## Comments

{{COMMENTS}}

Output ONLY the JSON object.
