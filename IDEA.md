pocketBrain, the idea (no code)
================================

Take this and build your own, or use ours: this repository.

If you use one AI assistant, you don't need any of this. Keep a folder of
Markdown notes, let your assistant maintain it (summaries, links, an index,
a pass that looks for contradictions), and skip the vector database until
search actually fails you.

This file is for the day a second assistant needs your notes, especially
one run by a vendor you don't control. A shared wiki has no walls. Whoever
reads it reads everything, whatever an assistant has seen can't be taken
back, and you can't tell which assistant read or wrote what.

The pattern
-----------

1. One brain, plain files. Markdown with YAML frontmatter, one note per
   file, in a git repo you own. Facts that go stale carry a date and the
   source they came from.

2. Assistants sit outside the wall. None of them opens the files. Each
   one talks to a small server with its own token, and the token is the
   only thing that says who it is.

3. A carve per assistant. You write down, in a file only you edit, which
   areas, note types, fields and sensitivity level each assistant gets.
   Every answer the server gives is computed from that carve.

4. Hidden looks like missing. A note outside the carve answers exactly
   like a note that doesn't exist, in search, read and context. A link to
   it shows as [[redacted]]. A hidden value inside a visible sentence shows
   as [withheld].

5. Writes go through checks, in code. Refuse secrets, instructions aimed
   at the next reader, edits to your rules, and any value the writer was
   never shown (that last one is how an assistant gets caught relaying
   something it learned elsewhere). New assistants propose; you accept.

6. Assistants don't message each other directly. Mail between them goes
   through a relay that checks each message against the recipient's carve
   and holds anything it shouldn't see.

7. Every write is a commit by the assistant that made it. Reads go to an
   append-only, hash-chained log the assistants can't write to. You can
   ask what an assistant holds on a topic, why, and what it was handed.

8. Revocation is one command and takes effect on the next request. Pause
   and read-only hold everywhere: reads, writes and the relay.

9. Models never enforce anything. Every check above is plain code. A model
   may help with chores (spotting duplicates, extracting facts from a
   capture), and its output becomes a proposal for you.

What this doesn't solve
-----------------------

An assistant that can see a fact can repeat it in other words. Carving
decides who sees what; it can't make an assistant forget. Keep the slice
small for assistants you trust less.

Where it gets hard (why the code exists)
----------------------------------------

The pattern fits on a page. The work is in the edges: matching hidden
values when they come back spaced, encoded or with look-alike letters;
making sure a hidden note leaves no trace in search ranking or error
messages; answering each assistant from a directory that only holds its
slice, so one bug can't leak another assistant's data; keeping the log
tamper-evident; and testing all of it with attacks rather than examples.
That's what the repository is.
