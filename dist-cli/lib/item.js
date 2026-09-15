"use strict";
// The item model and the pure functions over it.
//
// Split out from store.ts so the scorer can use them without importing the
// persistence layer that imports the scorer straight back.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parse = parse;
exports.splitTags = splitTags;
exports.matches = matches;
/**
 * Turns one line of text into an item.
 *
 * The first #word becomes the project. Any @word, and any later #word,
 * becomes a tag. Everything else is the title. All of it is optional —
 * a bare line of text is a perfectly good item.
 */
function parse(input) {
    const tags = [];
    let project;
    const titleWords = [];
    for (const word of input.trim().split(/\s+/)) {
        const body = word.slice(1).toLowerCase();
        if (word.startsWith("#") && body.length > 0) {
            if (project === undefined)
                project = body;
            else
                tags.push(body);
        }
        else if (word.startsWith("@") && body.length > 0) {
            tags.push(body);
        }
        else if (word.length > 0) {
            titleWords.push(word);
        }
    }
    return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: titleWords.join(" ") || input.trim(),
        description: "",
        project,
        tags: [...new Set(tags)],
        status: "todo",
        createdAt: Date.now(),
    };
}
function splitTags(input) {
    return [
        ...new Set(input
            .split(/[,\s]+/)
            .map((t) => t.replace(/^[@#]/, "").trim().toLowerCase())
            .filter((t) => t.length > 0)),
    ];
}
function matches(item, query) {
    const q = query.trim().toLowerCase();
    if (q.length === 0)
        return true;
    const haystack = [item.title, item.description, item.project ?? "", ...item.tags].join(" ").toLowerCase();
    return q.split(/\s+/).every((term) => haystack.includes(term.replace(/^[@#]/, "")));
}
