# Rubric provenance

What the rubric's author fetched and searched for, taken from the session event log. The log
is not committed. This file is the record that the README's *Contamination* section relies
on.

- **Author.** The built-in `research` agent, on `claude-sonnet-5`, dispatched at 17:58 UTC
  on 2026-09-28. All 134 tool calls made on that model after the dispatch carry the
  author's agent id.
- **Calls.** 134 in all: 69 `web_fetch` (50 succeeded), 28 `web_search` and 37 `powershell`.
  There were no `view`, `grep` or `glob` calls.
- **PowerShell.** Every call builds the text of a transport piece. With string literals and
  here-strings masked, none reads a file, runs a program or reaches the network.
- **Timing.** The web calls ran 18:02:50–18:29:26 UTC, in the research pass. PowerShell
  ran from 19:02:54, in the regeneration. The regeneration made no web call.
- **Blindness.** No search and no URL names the repository, its tools or the user.

## The five papers marked "fetched"

| Paper | What was fetched | DOI page fetched? | Where the DOI is cited | Where the fetched record is cited |
|---|---|---|---|---|
| Cowan (2001) | the Cambridge record, reached through the DOI's redirect: abstract | yes | Sources, SOURCES CONSULTED | CRAFT-02, OBJ-09 |
| Richter, Scheiter & Eitel (2016) | the psycharchives.org record: abstract | no | Sources, SOURCES CONSULTED | OBJ-03, OBJ-10 |
| Rey (2012) | the eric.ed.gov record: abstract, without author or journal | no | Conflicts, Sources, SOURCES CONSULTED | OBJ-11 |
| Craig & Schroeder (2017) | the asu.elsevierpure.com record: abstract | no | Sources, SOURCES CONSULTED | — |
| Kalyuga, Ayres, Chandler & Sweller (2003) | the ro.uow.edu.au record: abstract | no (the publisher page failed) | OBJ-18, Conflicts, Sources, SOURCES CONSULTED | — |

## Every web call

| # | Time (UTC) | Tool | Succeeded | URL or query |
|---|---|---|---|---|
| 1 | 18:02:50 | web_fetch | yes | https://www.w3.org/TR/WCAG22/ |
| 2 | 18:02:50 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html |
| 3 | 18:02:50 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html |
| 4 | 18:02:50 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html |
| 5 | 18:02:50 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html |
| 6 | 18:02:50 | web_fetch | yes | https://thecrashcourse.com/creator-lab/ |
| 7 | 18:02:50 | web_fetch | yes | https://esteem.nd.edu/news/7-step-guide-to-creating-online-video-courses/ |
| 8 | 18:02:50 | web_fetch | yes | https://www.academyforvirtualteaching.com/courses/video-making-crash-course |
| 9 | 18:02:50 | web_fetch | yes | https://www.indie-film-making.com/how-to-make-a-video/ |
| 10 | 18:03:10 | web_fetch | yes | https://www.youtube.com/watch?v=6xk4iUuL4IY |
| 11 | 18:03:10 | web_fetch | yes | https://www.youtube.com/watch?v=ArBS88h1r2Q |
| 12 | 18:03:10 | web_search | yes | Mayer Moreno "Nine Ways to Reduce Cognitive Load in Multimedia Learning" Educational Psychologist 2003 pdf |
| 13 | 18:03:10 | web_search | yes | Kalyuga Ayres Chandler Sweller 2003 "The Expertise Reversal Effect" Educational Psychologist pdf |
| 14 | 18:03:10 | web_search | yes | Ginns 2006 meta-analysis "spatial contiguity" "temporal contiguity" Learning and Instruction effect size |
| 15 | 18:03:10 | web_search | yes | Craig Schroeder "voice principle" multimedia learning machine voice synthetic TTS study |
| 16 | 18:03:10 | web_search | yes | Richter Scheiter Eitel 2016 signaling meta-analysis "Educational Research Review" text-picture |
| 17 | 18:03:10 | web_search | yes | Rey 2012 "seductive details" meta-analysis Educational Research Review effect size |
| 18 | 18:04:50 | web_fetch | yes | https://docslib.org/doc/4316624/nine-ways-to-reduce-cognitive-load-in-multimedia-learning |
| 19 | 18:04:50 | web_fetch | yes | https://ro.uow.edu.au/cgi/viewcontent.cgi?article=1051&context=edupapers |
| 20 | 18:04:50 | web_fetch | yes | https://files.eric.ed.gov/fulltext/EJ1341358.pdf |
| 21 | 18:04:50 | web_search | yes | Cowan 2001 "The magical number 4 in short-term memory" capacity limit pdf |
| 22 | 18:04:50 | web_search | yes | Mayer Johnson 2008 "Revisiting the redundancy principle in multimedia learning" Journal of Educational Psychology |
| 23 | 18:04:50 | web_search | yes | Spanjers van Gog van Merrienboer segmentation effect meta-analysis system-paced animation expertise reversal |
| 24 | 18:04:50 | web_search | yes | Sweller van Merrienboer Paas 2019 "Cognitive Architecture and Instructional Design: 20 Years Later" Educational Psychology Review open access |
| 25 | 18:07:13 | web_fetch | yes | https://www.cambridge.org/core/journals/behavioral-and-brain-sciences/article/magical-number-4-in-short-term-memory-a-reconsideration-of-mental-storage-capacity/44023F1147D4A1D44BDC0AD226838496 |
| 26 | 18:07:13 | web_fetch | no | https://link.springer.com/article/10.1007/s10648-019-09465-5 |
| 27 | 18:07:13 | web_fetch | no | https://www.academia.edu/4708038/The_Expertise_Reversal_Effect |
| 28 | 18:07:13 | web_fetch | yes | https://psycharchives.org/en/item/7bf33e3f-9355-4fc8-90cd-6618021338ac |
| 29 | 18:07:13 | web_fetch | no | https://eric.ed.gov/?id=EJ986386 |
| 30 | 18:07:13 | web_fetch | no | https://eric.ed.gov/?q=redundancy+principle+&id=EJ796353 |
| 31 | 18:07:13 | web_fetch | yes | https://research.ou.nl/en/publications/an-expertise-reversal-effect-of-segmentation-in-learning-from-ani/ |
| 32 | 18:07:13 | web_fetch | yes | https://asu.elsevierpure.com/en/publications/reconsidering-the-voice-effect-when-learning-from-a-virtual-human/ |
| 33 | 18:07:13 | web_fetch | yes | https://www.w3.org/WAI/media/av/ |
| 34 | 18:07:13 | web_search | yes | Mayer Sobko Mautone 2003 "Social cues in multimedia learning" voice principle Journal of Educational Psychology abstract |
| 35 | 18:08:03 | web_fetch | yes | https://www.w3.org/WAI/media/av/description/ |
| 36 | 18:08:03 | web_fetch | yes | https://www.w3.org/WAI/media/av/av-content/ |
| 37 | 18:08:03 | web_fetch | no | https://paperity.org/p/185701240/cognitive-architecture-and-instructional-design-20-years-later |
| 38 | 18:08:03 | web_fetch | yes | https://eric.ed.gov/?id=EJ986386 |
| 39 | 18:08:03 | web_fetch | no | https://www.tandfonline.com/doi/abs/10.1207/S15326985EP3801_4 |
| 40 | 18:08:03 | web_search | yes | "Expertise Reversal Effect" Kalyuga 2003 tandfonline.com abstract site:tandfonline.com |
| 41 | 18:08:03 | web_search | yes | "Nine Ways to Reduce Cognitive Load" tandfonline abstract page doi 10.1207/S15326985EP3801_6 |
| 42 | 18:09:50 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics.html |
| 43 | 18:09:50 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html |
| 44 | 18:09:50 | web_fetch | yes | https://www.w3.org/WAI/media/av/captions/ |
| 45 | 18:09:50 | web_fetch | no | https://www.scilit.com/publications/cdabc211bcae496854cf82e60a2dc966 |
| 46 | 18:09:50 | web_search | yes | semanticscholar.org "Expertise Reversal Effect" Kalyuga Ayres Chandler Sweller 2003 |
| 47 | 18:09:50 | web_search | yes | Ginns 2006 "Integrating information" spatial contiguity temporal contiguity sciencedirect abstract |
| 48 | 18:11:20 | web_fetch | no | https://www.sciencedirect.com/science/article/pii/S0959475206000806 |
| 49 | 18:11:20 | web_fetch | no | https://oa.mg/work/10.1037/0022-0663.95.2.419 |
| 50 | 18:11:20 | web_fetch | no | https://psycnet.apa.org/doiLanding?doi=10.1207%2FS15326985EP3801_6 |
| 51 | 18:11:20 | web_fetch | no | https://api.semanticscholar.org/graph/v1/paper/search?query=The%20Expertise%20Reversal%20Effect%20Kalyuga%20Ayres%20Chandler%20Sweller&fields=title,year,abstract,authors,venue,externalIds |
| 52 | 18:11:20 | web_fetch | no | https://api.semanticscholar.org/graph/v1/paper/search?query=Nine%20Ways%20to%20Reduce%20Cognitive%20Load%20in%20Multimedia%20Learning&fields=title,year,abstract,authors,venue,externalIds |
| 53 | 18:11:58 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html |
| 54 | 18:11:58 | web_fetch | yes | https://www.w3.org/WAI/media/av/av-content/ |
| 55 | 18:11:58 | web_fetch | yes | https://www.w3.org/WAI/media/av/description/ |
| 56 | 18:11:58 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics.html |
| 57 | 18:11:58 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html |
| 58 | 18:12:08 | web_fetch | no | https://api.semanticscholar.org/graph/v1/paper/search?query=Expertise+Reversal+Effect+Kalyuga&fields=title,year,abstract,venue,externalIds |
| 59 | 18:12:08 | web_fetch | no | https://api.semanticscholar.org/graph/v1/paper/search?query=Nine+Ways+Reduce+Cognitive+Load+Multimedia+Learning+Mayer+Moreno&fields=title,year,abstract,venue,externalIds |
| 60 | 18:12:30 | web_fetch | no | https://www.researchgate.net/publication/232540768_Revising_the_Redundancy_Principle_in_Multimedia_Learning |
| 61 | 18:12:30 | web_search | yes | researchgate.net publication Kalyuga Ayres Chandler Sweller "Expertise Reversal Effect" 2003 |
| 62 | 18:12:30 | web_search | yes | researchgate.net publication Ginns 2006 "Integrating information" spatial contiguity temporal contiguity meta-analysis |
| 63 | 18:13:13 | web_fetch | yes | https://ro.uow.edu.au/articles/journal_contribution/The_expertise_reversal_effect/27724950 |
| 64 | 18:13:43 | web_fetch | no | https://www.researchgate.net/profile/Paul-Ginns/publication/248498142_Integrating_information_A_meta-analysis_of_the_spatial_contiguity_and_temporal_contiguity_effects/links/5f2cd0b5299bf13404ab4fe4/Integrating-information-A-meta-analysis-of-the-spatial-contiguity-and-temporal-contiguity-effects.pdf |
| 65 | 18:13:43 | web_search | yes | "Nine Ways to Reduce Cognitive Load" Mayer Moreno filetype:pdf site:edu |
| 66 | 18:14:46 | web_fetch | no | https://www.unm.edu/~moreno/PDFS/edu_psych_cog.pdf |
| 67 | 18:14:51 | web_fetch | yes | https://www.uky.edu/~gmswan3/544/9_ways_to_reduce_CL.pdf |
| 68 | 18:16:06 | web_search | yes | site:semanticscholar.org "Nine Ways to Reduce Cognitive Load in Multimedia Learning" |
| 69 | 18:16:06 | web_search | yes | site:semanticscholar.org Ginns "Integrating information" spatial contiguity temporal contiguity |
| 70 | 18:17:26 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/low-or-no-background-audio.html |
| 71 | 18:17:26 | web_search | yes | PMC NCBI open access meta-analysis "spatial contiguity" OR "redundancy principle" multimedia learning effect size |
| 72 | 18:17:26 | web_search | yes | Schroeder Cenkci 2018 spatial contiguity meta-analysis effect size multimedia learning |
| 73 | 18:18:37 | web_fetch | no | https://eric.ed.gov/?id=EJ1186641 |
| 74 | 18:18:37 | web_fetch | yes | https://inspire.acu.edu.au/articles/contiguity-present-words-and-pictures-in-the-same-place-and-at-the-same-time |
| 75 | 18:18:49 | web_search | yes | semanticscholar.org paper Ginns 2006 "Integrating information" meta-analysis spatial temporal contiguity |
| 76 | 18:18:49 | web_fetch | no | https://doi.org/10.1007/s10648-018-9435-9 |
| 77 | 18:19:33 | web_fetch | yes | https://www.semanticscholar.org/paper/Integrating-information%3A-A-meta-analysis-of-the-and-Ginns/f0346cb724955b914874d34a96427aa0003f46d3 |
| 78 | 18:20:46 | web_search | yes | Cowan 2001 "magical number 4" short-term memory cambridge core behavioral brain sciences abstract |
| 79 | 18:20:46 | web_search | yes | Richter Scheiter Eitel 2016 "signaling" meta-analysis psycharchives learning instruction |
| 80 | 18:20:46 | web_search | yes | Rey 2012 "seductive detail effect" meta-analysis eric.ed.gov |
| 81 | 18:20:46 | web_search | yes | Craig Schroeder 2017 "Reconsidering the voice effect when learning from a virtual human" asu pure elsevier |
| 82 | 18:20:46 | web_search | yes | Kalyuga Ayres Chandler Sweller 2003 "expertise reversal effect" ro.uow.edu.au |
| 83 | 18:21:37 | web_fetch | yes | https://doi.org/10.1017/S0140525X01003922 |
| 84 | 18:21:37 | web_fetch | yes | https://psycharchives.org/en/item/7bf33e3f-9355-4fc8-90cd-6618021338ac |
| 85 | 18:21:37 | web_fetch | yes | https://eric.ed.gov/?id=EJ986386 |
| 86 | 18:21:37 | web_fetch | yes | https://asu.elsevierpure.com/en/publications/reconsidering-the-voice-effect-when-learning-from-a-virtual-human/ |
| 87 | 18:21:37 | web_fetch | yes | https://ro.uow.edu.au/articles/journal_contribution/The_expertise_reversal_effect/27724950 |
| 88 | 18:22:05 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html |
| 89 | 18:22:05 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/sensory-characteristics.html |
| 90 | 18:22:05 | web_fetch | yes | https://www.w3.org/WAI/media/av/description/ |
| 91 | 18:22:05 | web_fetch | yes | https://www.w3.org/WAI/media/av/av-content/ |
| 92 | 18:22:28 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html |
| 93 | 18:22:28 | web_fetch | yes | https://www.w3.org/WAI/media/av/av-content/ |
| 94 | 18:22:47 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html |
| 95 | 18:22:47 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html |
| 96 | 18:29:26 | web_fetch | yes | https://www.w3.org/WAI/WCAG22/Understanding/audio-description-or-media-alternative-prerecorded.html |
| 97 | 18:29:26 | web_fetch | yes | https://www.w3.org/WAI/media/av/captions/ |
