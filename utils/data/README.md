# utils/data

`words-en.txt.gz`: English words, one a line, lower case, every form
(hunspell's en_US list with its affixes applied: "transfer", "transfers",
"basically"), letters a to z only, three letters or more plus a few
two-letter words ("go", "my", "mr"). `utils/studio-films.js` (minorRunIns)
reads it to tell an English word that holds a name's letters ("island" for
an Isla) from a name run into a tag ("#jordanfootball").

Made from SCOWL by way of the hunspell en_US dictionary (Debian's
hunspell-en-us, 2022). Its copyright and permission notices, from SCOWL and
the lists in it (among them UKACD's, which asks that its text be included
verbatim), are in `LICENSE-words-en.txt`, copied whole.
