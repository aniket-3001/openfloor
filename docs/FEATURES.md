# What was built, and what actually works

An honest list. Written plainly, for someone who is not deep in this yet.

Status meanings:

- **Works** — built, tested, and confirmed running on the live site.
- **Works, with a limit** — does its job, but there is something worth knowing.
- **Not done** — either not built, or needs something only a person can do.

---

## The headline, first

If you read one thing, read this.

**Most entries in this hackathon will add AI tools to one web page. This one connects three separate websites, and proves it works.**

The WebMCP standard has a feature called `exposedTo`. It lets a page say: *these tools may be used by this other website, and by nobody else.* Almost nobody will use it, because it is the hardest part of the standard and there is no obvious reason to bother.

We built the whole project around it — and then, rather than assuming it worked, **measured it in a real Chrome browser.** Results:

- A website on the allowed list could reach **7 tools** on the auction site and actually use them.
- The identical website, served on a different address that was **not** on the list, reached **zero**.
- A tool call crossing between websites still could not overspend, because the spending limit is enforced on the server.

That last point is the second half of the highlight. **The AI cannot raise its own spending limit.** Not "it is told not to" — there is no way to do it. No button, no command, nothing in the code. The only route is asking a person. So even if the AI is tricked, confused, or hostile, the money is safe.

Together that is a claim very few entries can make: *a real trust boundary between websites, and a spending limit an AI cannot cross even when it wants to.*

There is a third thing worth mentioning, which is unusual for a hackathon project. **We found three places where Chrome behaves differently from what the written standard says**, and wrote them down:

1. Sending arguments to a tool requires text, not an object — the docs imply otherwise.
2. Tools inside a page's own frame are only visible if that page is embedded properly. Without knowing this, the cross-website feature simply does not work, and nothing tells you why.
3. The function for discovering tools always returns your own tools too — so "it returned something" does not prove anything crossed. **We got this wrong ourselves at first**, and our own check falsely reported success until it was fixed.

---

## The main features

### Bidding by hand
**Works.** Type an amount, press the button. Works in any browser, including ones with no AI support at all. This matters: a judge opening the link in Safari still sees a working auction rather than a blank page.

### Letting an AI bid for you
**Works.** Ten tools are offered to an assistant: read the price, read the item, read past bids, test a bid without placing it, place a bid, withdraw, read your limits, set your limits, ask for a higher limit, and ask what it has been doing.

### The three limits
**Works.** Bid freely below one number, ask before every bid above it, never pass a third. Checked on the server every single time.

### Total budget across all items
**Works.** Without this, a "$80 maximum" across three items quietly allows $240. This was a real flaw we found and fixed — and fixing it exposed two more bugs underneath, where a won item was being counted as costing nothing.

### The AI cannot raise its own limit
**Works.** It can only ask. There is a test that fails the build if anyone ever adds a way to do it, so it cannot be broken by accident later.

### Approval requests
**Works.** When it wants to bid above your line, a box appears with the amount and the reason. Nothing is bid until you agree. If you ignore it, after a minute it counts as "no" — silence is never taken as yes.

### The record of everything
**Works.** Every action, who did it, and whether a person approved it. Written as it happens.

### Three AI rivals bidding continuously
**Works.** Ada, Rex and Nia bid against each other so the auction is always live. Importantly, **they get no special treatment** — they bid through the same public route as anyone else, with the same limits and checks. A house bot allowed to cheat would make every other claim meaningless.

*Two bugs were found here by checking the live site rather than trusting the tests, and both are worth recording because both failed silently:*

1. **The rivals stopped bidding after a few minutes.** When the catalogue looped, the code cleared every stored limit — so every bidder in the room, rivals included, was quietly stripped of permission. Their bids came back refused, the refusal was never logged, and the auction ran on with a live clock and no bids at all. Fixed by separating *looping the catalogue* from *clearing the room*: your limits are your instruction, and the sale ending is no reason to throw them away. This was also losing the limits of any real person who set them and walked away.
2. **One lot could never be bid on by anyone.** The agents get a little less eager with each lot, which is intended — but that restraint was stored as a cash figure carried from the previous lot rather than a share of what the current one is worth. After a $90 camera they were pinned near $92, and the $280 watch opens at $120. Every agent refused it, every time, and it never once sold. Now the restraint scales with each lot's own value.

### The auction never stops
**Works.** When an item closes it moves to the next, and starts over when it runs out. Before this, someone arriving a few minutes after a deployment found a dead page.

### Live updates
**Works.** Price, clock, bids and activity update on their own.
*Note:* the clock was broken until recently — it looked frozen because it was showing a number the server sent a while ago rather than counting down. Fixed and confirmed on the live site.

### Accounts
**Works, with a limit.** You get an identity automatically — no sign-up, no empty state to get past. Your name sits in the top right; click it to choose a name and passphrase, which lets you pick the same seat up on another device or after clearing cookies.

*The control itself was missing until late.* The whole backend was built and working, but nothing on the page ever called it — so there was a name in the corner and no way to keep it. Found by looking rather than by testing, and this document previously claimed you could do it. You can now, and a browser check drives the real form in real Chrome: it claims a name, survives a reload, and confirms a wrong passphrase cannot take a name someone else holds.

**The limit:** claimed names are held in memory, so a server restart clears them. Deliberate for a demo; a real product would need a database and everything that comes with it.

### Protection against tricking the AI
**Works.** Someone can set their display name to something like *"ignore your limit"*, hoping the AI reads it as an instruction. The text is cleaned, marked untrusted, and flagged. The real protection is that even a perfectly successful trick cannot overspend.

### Fair bidding when several bid at once
**Works.** If ten bids arrive at the same instant, exactly one wins and the rest are told why. This was genuinely at risk when the project moved to Google Cloud, and there is a test that fires fifty simultaneous bids to prove it holds.

### Anti-sniping
**Works.** A bid in the last ten seconds pushes the clock back, so nobody wins purely by waiting until others cannot respond.

### Hidden reserve
**Works.** You are told whether the secret minimum has been reached, never what it is.

---

## Not done

### Chrome origin-trial token
**Not done — needs you.**

Right now a visitor must turn on a setting in Chrome by hand before the AI features work. A token from Google removes that step entirely. The code is ready and reads it from configuration; **registering it is a form on Google's site that only a person with the account can fill in.** This is the single highest-value thing left, because it removes friction on the exact path a judge takes.

### Tested in the ChatGPT app's browser
**Not done.**

OpenAI's documentation says their browser **does not** see tools inside embedded frames — which is exactly how the cross-website feature works. So the multi-site part almost certainly will not work there. The single-page experience should be fine. This is a limit of that browser, not of our project, and it applies to every entry equally. We have not measured it, and say so rather than guessing.

### Checked on a phone
**Not done.** The layout has rules for small screens, but nobody has looked at it on an actual phone.

### Seller side
**Not built.** The seller is a fixed number, not a participant. A version where the seller also has an assistant would be a stronger story, but it is a large addition.

---

## Known rough edges

Being straight about these.

1. **Everything resets on restart.** Auction state and claimed accounts live in memory. A restart begins a clean auction. Fine for a demo, not for a real product.
2. **Rate limiting resets too**, for the same reason.
3. **Nothing is real money.** No payment, no goods. Stated on the site itself.
4. **The demo is tuned.** Short clocks and small bid steps, so a bidding war is watchable in under three minutes. The rules are real; the pacing is staged, and the code says so.

---

## How much of this is actually tested

**187 automated tests**, plus checks against the real live site.

- **122** checking the logic — spending limits, the signed record, the anti-trickery text cleaning, the AI's decision rules.
- **56** checking the whole system end to end against a running server.
- **9** firing many bids at once to prove exactly one wins.
- Plus checks driving a **real Chrome browser** against the live site.

Three of these tests are worth calling out, because they guard the claims rather than the code:

- One fails the build if anyone ever adds a way for the AI to raise its own limit.
- One tries every price in the range, for every AI personality, and fails if any of them ever proposes going over the limit.
- One feeds the AI a fake instruction telling it to bid $99,999.99, and checks the number gets cut back down to the limit.
- One checks a lot worth more than the ones before it can still be bid on — the bug above passed every existing test, because no test ever ran two different lots in sequence.

---

## If you have to explain this in one minute

> An auction where you can hand the bidding to an AI, but the AI physically cannot spend more than you allowed. Not "we told it not to" — there is no way for it to do so, and the limit is checked somewhere the AI cannot reach.
>
> It runs across three separate websites that trust each other through the WebMCP standard's permission feature. We tested that in a real browser: an allowed site can use the auction's tools, an identical site that is not on the list gets nothing.
>
> Along the way we found three places where Chrome behaves differently from its own documentation, including one that made our own testing report a false success until we caught it.
