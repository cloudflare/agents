----------------------------- MODULE McpSession -----------------------------
(***************************************************************************)
(* McpAgent streamable HTTP: how the Worker handler and the session's      *)
(* Durable Object agree on whether a session exists.                       *)
(*                                                                         *)
(* The Worker (createStreamingHttpHandler, mcp/server/utils.ts) serves one *)
(* HTTP request with several separate calls to the object. Other requests  *)
(* for the same session run between those calls.                           *)
(*                                                                         *)
(* Code map:                                                               *)
(*   Start      the request arrives; an initialize gets a new id from      *)
(*              namespace.newUniqueId(), any other request carries an id   *)
(*              the client chose                                           *)
(*   Ensure     getAgentByName -> __unsafe_ensureInitialized: the object   *)
(*              is created, its constructor makes the cf_agents_* tables   *)
(*              and onStart stores `props`                                 *)
(*   Read       agent.getInitializeRequest()                               *)
(*   Set        agent.setInitializeRequest()                               *)
(*   Upgrade    agent.fetch() with Upgrade: websocket; onConnect hands the *)
(*              message to the transport. With CheckInObject this is       *)
(*              McpAgent.fetch -> _admitStreamableHttp, which stores an    *)
(*              initialize request and refuses any other message for a     *)
(*              session it does not have                                   *)
(*   Terminate  agent._cf_terminateSession(): schedule destroy, delete the *)
(*              stored initialize request                                  *)
(*   Alarm      the deferred destroy(): storage.deleteAll()                *)
(*   Die        the Worker invocation ends between two calls (the client   *)
(*              went away)                                                 *)
(*                                                                         *)
(* Switches:                                                               *)
(*   SkipInitRead   #2814: an initialize does not Read                     *)
(*   CleanupOnMiss  a request for an unknown session schedules the         *)
(*                  object's destroy before answering 404                  *)
(*   CheckInObject  the object checks the session when it accepts the      *)
(*                  upgrade; the Worker neither Reads nor Sets first       *)
(*   OneCall        the whole request is one call to the object (not       *)
(*                  built: the Worker still calls getAgentByName first)    *)
(*   WorkerCanDie   enables Die                                            *)
(*                                                                         *)
(* The code is SkipInitRead, CleanupOnMiss and CheckInObject.              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Reqs, Fresh, Bogus,
          SkipInitRead, CleanupOnMiss, CheckInObject, OneCall, WorkerCanDie

VARIABLES obj, pc, kind, sid, saw, minted, known, servedDead

vars == <<obj, pc, kind, sid, saw, minted, known, servedDead>>

Sids == Fresh \cup Bogus
Empty == [init |-> FALSE, residue |-> FALSE, condemned |-> FALSE]

TypeOK ==
  /\ obj \in [Sids -> [init : BOOLEAN, residue : BOOLEAN, condemned : BOOLEAN]]
  /\ pc \in [Reqs -> {"idle", "ensure", "read", "set", "upgrade", "terminate", "done"}]
  /\ kind \in [Reqs -> {"none", "init", "use", "delete"}]
  /\ sid \in [Reqs -> Sids]
  /\ saw \in [Reqs -> BOOLEAN]
  /\ minted \subseteq Fresh
  /\ known \subseteq minted
  /\ servedDead \subseteq Reqs

Init ==
  /\ obj = [s \in Sids |-> Empty]
  /\ pc = [r \in Reqs |-> "idle"]
  /\ kind = [r \in Reqs |-> "none"]
  /\ sid = [r \in Reqs |-> CHOOSE s \in Sids : TRUE]
  /\ saw = [r \in Reqs |-> FALSE]
  /\ minted = {}
  /\ known = {}
  /\ servedDead = {}

\* newUniqueId() is unguessable: a client can only send an id a response
\* gave it, or one it made up that will never be minted.
Start(r) ==
  /\ pc[r] = "idle"
  /\ \/ \E s \in Fresh \ minted :
          /\ kind' = [kind EXCEPT ![r] = "init"]
          /\ sid' = [sid EXCEPT ![r] = s]
          /\ minted' = minted \cup {s}
     \/ \E s \in known \cup Bogus, k \in {"use", "delete"} :
          /\ kind' = [kind EXCEPT ![r] = k]
          /\ sid' = [sid EXCEPT ![r] = s]
          /\ UNCHANGED minted
  /\ pc' = [pc EXCEPT ![r] = "ensure"]
  /\ UNCHANGED <<obj, saw, known, servedDead>>

\* The answer is 404 "Session not found".
Miss(r, o) ==
  /\ obj' = [obj EXCEPT ![sid[r]] =
               [o EXCEPT !.condemned = o.condemned \/ CleanupOnMiss]]
  /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ UNCHANGED <<known, servedDead>>

Serve(r, o) ==
  /\ obj' = [obj EXCEPT ![sid[r]] = o]
  /\ servedDead' = IF o.init THEN servedDead ELSE servedDead \cup {r}
  /\ known' = IF kind[r] = "init" THEN known \cup {sid[r]} ELSE known
  /\ pc' = [pc EXCEPT ![r] = "done"]

End(r, o) ==
  /\ obj' = [obj EXCEPT ![sid[r]] =
               [o EXCEPT !.init = FALSE, !.condemned = TRUE]]
  /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ UNCHANGED <<known, servedDead>>

Ensure(r) ==
  /\ pc[r] = "ensure"
  /\ LET o == [obj[sid[r]] EXCEPT !.residue = TRUE] IN
       IF OneCall
       THEN /\ CASE kind[r] = "init" -> Serve(r, [o EXCEPT !.init = TRUE])
                 [] ~o.init -> Miss(r, o)
                 [] kind[r] = "use" -> Serve(r, o)
                 [] OTHER -> End(r, o)
            /\ UNCHANGED saw
       ELSE /\ obj' = [obj EXCEPT ![sid[r]] = o]
            /\ pc' = [pc EXCEPT ![r] =
                 CASE kind[r] = "init" -> IF CheckInObject THEN "upgrade"
                                          ELSE IF SkipInitRead THEN "set"
                                          ELSE "read"
                   [] kind[r] = "use" -> IF CheckInObject THEN "upgrade" ELSE "read"
                   [] OTHER -> "read"]
            /\ UNCHANGED <<saw, known, servedDead>>
  /\ UNCHANGED <<kind, sid, minted>>

Read(r) ==
  /\ pc[r] = "read"
  /\ saw' = [saw EXCEPT ![r] = obj[sid[r]].init]
  /\ IF kind[r] = "init"
     THEN /\ pc' = [pc EXCEPT ![r] = "set"]
          /\ UNCHANGED <<obj, known, servedDead>>
     ELSE IF obj[sid[r]].init
     THEN /\ pc' = [pc EXCEPT ![r] =
                      IF kind[r] = "use" THEN "upgrade" ELSE "terminate"]
          /\ UNCHANGED <<obj, known, servedDead>>
     ELSE Miss(r, obj[sid[r]])
  /\ UNCHANGED <<kind, sid, minted>>

Set(r) ==
  /\ pc[r] = "set"
  /\ obj' = [obj EXCEPT ![sid[r]].init = TRUE]
  /\ pc' = [pc EXCEPT ![r] = "upgrade"]
  /\ UNCHANGED <<kind, sid, saw, minted, known, servedDead>>

\* A fetch wakes the object like any call, so it also leaves storage behind.
Upgrade(r) ==
  /\ pc[r] = "upgrade"
  /\ LET o == [obj[sid[r]] EXCEPT !.residue = TRUE] IN
       CASE kind[r] = "init" -> Serve(r, [o EXCEPT !.init = TRUE])
         [] CheckInObject /\ ~o.init -> Miss(r, o)
         [] OTHER -> Serve(r, o)
  /\ UNCHANGED <<kind, sid, saw, minted>>

Terminate(r) ==
  /\ pc[r] = "terminate"
  /\ End(r, obj[sid[r]])
  /\ UNCHANGED <<kind, sid, saw, minted>>

Alarm(s) ==
  /\ obj[s].condemned
  /\ obj' = [obj EXCEPT ![s] = Empty]
  /\ UNCHANGED <<pc, kind, sid, saw, minted, known, servedDead>>

Die(r) ==
  /\ WorkerCanDie
  /\ pc[r] \notin {"idle", "done"}
  /\ pc' = [pc EXCEPT ![r] = "done"]
  /\ UNCHANGED <<obj, kind, sid, saw, minted, known, servedDead>>

Next ==
  \/ \E r \in Reqs :
       Start(r) \/ Ensure(r) \/ Read(r) \/ Set(r) \/ Upgrade(r)
         \/ Terminate(r) \/ Die(r)
  \/ \E s \in Sids : Alarm(s)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* PR #2814: the read an initialize makes never finds anything, so dropping
\* it changes no outcome.
InitReadSeesNothing == \A r \in Reqs : kind[r] = "init" => ~saw[r]

\* An object that holds storage is a session, is scheduled for deletion, or
\* has a request in flight. Otherwise nothing will ever delete it.
NoLeftovers ==
  \A s \in Sids :
    (obj[s].residue /\ ~obj[s].init /\ ~obj[s].condemned)
      => \E r \in Reqs : sid[r] = s /\ pc[r] \notin {"idle", "done"}

\* A request is never handed to a session that has been ended.
TerminatedIsNotServed == servedDead = {}
=============================================================================
