## How to write the text

memelint examines the pull request description with the ASD-STE100 dictionary in `strict` mode. If the text does not obey these instructions, the run stops with an error.

- Use only approved expressions. Put each name of the code, each path and each command in backticks: memelint does not examine them.
- Write one fact in each sentence. A sentence has 25 words or less. An instruction has 20 words or less.
- Do not write `don't` or `it's`. Write `do not` and `it is`.
- Do not use a verb that ends in `-ing`. Write `the change removes`, not `removing`.
- Use the active voice. Write `the package reads the file`, not `the file is read by the package`.
- Do not write `'s`. Write `the trust store of the JRE`, not `the JRE's trust store`.
- Put only names between backticks. Do not put a usual expression between backticks as a method to go through memelint. When memelint rejects a usual expression, use the approved alternative.
- When memelint rejects a technical name that the description must use: put it in `words.txt`, one name for each line. Do this only for the name of a product, a format or a specification.

Use the approved alternative for these words:

| Not approved | Approved |
|---|---|
| `says`, `states`, `describes`, `mentions`, `specifies` | tells, gives, shows |
| `runs`, `executes`, `implements`, `performs` | operates, does, starts |
| `computes` | calculates |
| `returns` | gives |
| `calls` | uses, starts |
| `matches` | agrees with |
| `differs from` | is different from |
| `however` | but |
| `therefore`, `so` | thus |
| `instead of` | `X, not Y` |
| `every`, `any` | each, all |
| `both` | the A and the B |
| `exactly` | accurately |
| `never` | do not, no |
| `skips` | does not do |
| `hard-coded` | constant |
| `verify`, `validate`, `ensure` | examine, make sure |
| `vendored` | bundled |
