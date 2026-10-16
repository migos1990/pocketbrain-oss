# Frozen brains, one per format

`<n>/` is a brain as format `<n>` laid it out, copied when that format shipped (`1/` is
`examples/brain` from before the `FORMAT` file). Don't edit these: `test/brain-format.test.ts`
migrates each one to the current format and checks that nothing is lost. A release that raises
`FORMAT` in `src/format.ts` adds the next folder. See docs/release.md, "Brain format".
