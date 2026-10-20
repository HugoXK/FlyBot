// The canonical scenario specs (#358). Each maps a user-journey row to a rubric over the run's
// text (the delivered messages of a mock or live run, joined in order). Kept small on purpose:
// one spec per journey the team cares about most, so a change that breaks the journey fails here
// before it reaches a person.
//
// A spec is `{ id, title, journey, rubric }` and is read by `run.mjs`. `rubric` is a `rubric.mjs`
// rubric. Add a row the same day its journey changes.

export const SPECS = Object.freeze([
  {
    id: 'P3-tree-split',
    title: 'Tree: Chief → children → one combined answer',
    journey: 'P3',
    // Chief names the children it delegates to, the children answer, and the final answer is one
    // piece that mentions their parts. A run that names nobody, or that leaves a child's result
    // out, fails.
    rubric: {
      must: ['Chief', /(travel|food|budget)/i, /(plan|itinerary|answer)/i],
      mustNot: [/\berror\b/i, /\bfailed\b/i, /I cannot help/i],
      order: [['Chief', /(plan|itinerary|answer)/i]],
    },
  },
  {
    id: 'P4-invite-approve',
    title: 'Social: invite a friend, message their Bot, the reply is held',
    journey: 'P4',
    rubric: {
      must: [/approv/i, /(friend|shared|invite)/i],
      mustNot: [/sk-[A-Za-z0-9]/],
    },
  },
  {
    id: 'P6-timeline',
    title: 'Timeline: a multi-Bot run shows lanes and utilization',
    journey: 'P6',
    rubric: {
      must: [/timeline/i, /(lane|utilization|wait)/i],
      mustNot: [/sk-[A-Za-z0-9]/],
    },
  },
  {
    id: 'memory-recall',
    title: 'Memory: a saved fact is recalled by meaning',
    journey: 'P2',
    rubric: {
      must: [/recall/i],
      mustNot: [],
    },
  },
])

export const specById = id => SPECS.find(spec => spec.id === id) ?? null
