------------------------------ MODULE McpStream ------------------------------
(***************************************************************************)
(* McpAgent streamable HTTP: one tool call on one POST stream, with the    *)
(* client losing its connection and resuming with Last-Event-ID.           *)
(*                                                                         *)
(* The server sends events 1..N for the request; event N is the response.  *)
(* Each event is stored (DurableObjectEventStore), then written to the     *)
(* WebSocket of the connection bound to the request, if one is open. The   *)
(* Worker bridge forwards each frame to the client as an SSE event.        *)
(*                                                                         *)
(* Code map (mcp/server/transport.ts unless noted):                        *)
(*   Emit     send() -> sendOnStream(): storeEvent, writeSSEEvent, and on  *)
(*            the response deleteStreamRequestIds + clearStream            *)
(*   Forward  the ws "message" listener in createStreamingHttpHandler      *)
(*            (utils.ts). The POST branch closes the SSE stream on a frame *)
(*            with `close`; the GET branch does not look at `close`        *)
(*   Drop     the client's connection goes away; frames not yet forwarded  *)
(*            are gone                                                     *)
(*   Resume   GET with Last-Event-ID -> handleGetRequest(): bind the new   *)
(*            connection to the stream if its request ids are still        *)
(*            stored, replay stored events after the id                    *)
(*                                                                         *)
(* Switches:                                                               *)
(*   ClearOnResponse  the stream's events are deleted as soon as the       *)
(*                    response is written. The code keeps them for         *)
(*                    McpAgent.FINISHED_STREAM_RETENTION_MS instead; the   *)
(*                    model does not cover a resume later than that        *)
(*   GetHonorsClose   the GET bridge closes on a frame with `close`        *)
(*   ReplayMarksLast  a replayed response ends the stream. The code closes *)
(*                    the connection after replaying a finished stream     *)
(*                                                                         *)
(* The code is ClearOnResponse off, GetHonorsClose and ReplayMarksLast on. *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS N, Conns, Post, ClearOnResponse, GetHonorsClose, ReplayMarksLast

VARIABLES emitted, store, reqs, conn, bound, wire, got

vars == <<emitted, store, reqs, conn, bound, wire, got>>

Frame == [id : 1..N, close : BOOLEAN]
Range(s) == {s[i] : i \in DOMAIN s}

RECURSIVE Ascending(_)
Ascending(S) ==
  IF S = {} THEN <<>>
  ELSE LET m == CHOOSE x \in S : \A y \in S : x <= y
       IN <<m>> \o Ascending(S \ {m})

TypeOK ==
  /\ emitted \in 0..N
  /\ store \subseteq 1..N
  /\ reqs \in BOOLEAN
  /\ conn \in [Conns -> {"unused", "open", "closed"}]
  /\ bound \in [Conns -> BOOLEAN]
  /\ wire \in [Conns -> Seq(Frame)]
  /\ got \in Seq(1..N)

Init ==
  /\ emitted = 0
  /\ store = {}
  /\ reqs = TRUE
  /\ conn = [c \in Conns |-> IF c = Post THEN "open" ELSE "unused"]
  /\ bound = [c \in Conns |-> c = Post]
  /\ wire = [c \in Conns |-> <<>>]
  /\ got = <<>>

Emit ==
  /\ emitted < N
  /\ LET k == emitted + 1
         last == k = N
     IN /\ emitted' = k
        /\ store' = IF last /\ ClearOnResponse THEN {} ELSE store \cup {k}
        /\ reqs' = IF last THEN FALSE ELSE reqs
        /\ wire' = [c \in Conns |->
                      IF conn[c] = "open" /\ bound[c]
                      THEN Append(wire[c], [id |-> k, close |-> last])
                      ELSE wire[c]]
  /\ UNCHANGED <<conn, bound, got>>

Forward(c) ==
  /\ conn[c] = "open"
  /\ wire[c] # <<>>
  /\ LET f == Head(wire[c])
         closes == f.close /\ (c = Post \/ GetHonorsClose)
     IN /\ got' = Append(got, f.id)
        /\ conn' = [conn EXCEPT ![c] = IF closes THEN "closed" ELSE "open"]
        /\ wire' = [wire EXCEPT ![c] = IF closes THEN <<>> ELSE Tail(wire[c])]
  /\ UNCHANGED <<emitted, store, reqs, bound>>

Drop(c) ==
  /\ conn[c] = "open"
  /\ conn' = [conn EXCEPT ![c] = "closed"]
  /\ wire' = [wire EXCEPT ![c] = <<>>]
  /\ UNCHANGED <<emitted, store, reqs, bound, got>>

\* The client resumes once it has lost its stream, has an event id to resume
\* from, and still waits for the response.
Resume(c) ==
  /\ conn[c] = "unused"
  /\ \A d \in Conns : conn[d] # "open"
  /\ got # <<>>
  /\ N \notin Range(got)
  /\ LET after == {k \in store : k > got[Len(got)]}
     IN wire' = [wire EXCEPT ![c] =
          [i \in 1..Cardinality(after) |->
             [id |-> Ascending(after)[i],
              close |-> ReplayMarksLast /\ Ascending(after)[i] = N]]]
  /\ conn' = [conn EXCEPT ![c] = "open"]
  /\ bound' = [bound EXCEPT ![c] = reqs]
  /\ UNCHANGED <<emitted, store, reqs, got>>

Next == Emit \/ \E c \in Conns : Forward(c) \/ Drop(c) \/ Resume(c)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* The client sees the events in order, each once.
InOrder == \A i, j \in DOMAIN got : i < j => got[i] < got[j]

\* Once the server has produced the response, the client has it, it is on
\* its way to the client, or a resume can still replay it.
ResponseNotLost ==
  (emitted = N /\ N \notin Range(got))
    => \/ N \in store
       \/ \E c \in Conns : conn[c] = "open" /\ N \in {f.id : f \in Range(wire[c])}

\* Once the client has the response, no stream for the request stays open.
StreamEndsWithResponse ==
  N \in Range(got) => \A c \in Conns : conn[c] # "open"
=============================================================================
