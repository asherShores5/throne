# Throne

A bathroom log for a few friends. Each person logs when they go, sees how many per day on a monthly calendar, and shares that with a small circle of Friends.

## Language

**Profile**:
One person's account and everything they have logged.
_Avoid_: User, account, member

**Display name**:
The non-unique name a Profile shows to its Friends.
_Avoid_: Username, handle

**Avatar**:
An emoji on a color that stands for a Profile.
_Avoid_: Profile picture, photo

**Friend**:
Another Profile you share everything with, both ways; a Profile has at most three.
_Avoid_: Follower, viewer, contact, buddy

**Friendship**:
The two-way link between two Friends; ending it ends it for both.
_Avoid_: Share, connection, follow

**Friend request**:
An offer from one Profile to another to form a Friendship, which the other accepts or declines.
_Avoid_: Follow, add

**Friend code**:
A short private code a Profile shares out of band so someone can send it a Friend request; it can be regenerated.
_Avoid_: Handle, username, invite code

**Home zone**:
A Profile's current time zone, given to each new Log as its Log zone.
_Avoid_: Timezone setting, locale

**Log zone**:
The time zone a Log was made in; it fixes the Log's Day forever.
_Avoid_: Timezone

**Day**:
The calendar date of a Log in its Log zone, used to count Logs.
_Avoid_: Date bucket

**Invite**:
A single-use link, created by an existing Profile, that is the only way to create a new Profile; it does not make anyone Friends.
_Avoid_: Referral, sign-up code

**Log**:
One bathroom visit at a point in time, with optional Details.
_Avoid_: Entry, event, visit, poop

**Details**:
The optional facts on a Log: Duration, Bristol type, Note and Flags.
_Avoid_: Metrics, extras

**Bristol type**:
The quality of a Log on the Bristol stool scale, 1 to 7.
_Avoid_: Quality, rating, score

**Flag**:
One of a fixed, built-in set of markers on a Log: urgent, pain, blood, constipated, diarrhea.
_Avoid_: Tag, label

### Social

**Reaction**:
An emoji a Friend puts on a Log, seen only by its author and the Log's owner.
_Avoid_: Like, emote

**Comment**:
A short text message a Friend writes on a Log, seen only by its author and the Log's owner.
_Avoid_: Reply, note (Note is a Detail)

**Summary**:
A weekly roll-up of last week's Log counts for a Profile and its Friends.
_Avoid_: Leaderboard, report, digest

**Award**:
A light-hearted title in a Summary given to one person for last week, such as Most regular.
_Avoid_: Badge, achievement, trophy
