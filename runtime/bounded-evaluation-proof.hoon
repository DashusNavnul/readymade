=/  base  .
=/  original-mink  mink
=/  mink
  |=  [[subject=* formula=*] unused=~]
  (original-mink [subject formula] |=(^ *(unit (unit))))
=/  tools
|%
++  trace-append
  |=  [out=@t text=@t]
  ^-  @t
  ?:  (gth (add 1 (add (met 3 out) (met 3 text))) 2.048)  out
  (cat 3 out (cat 3 '\0a' text))
++  trace-detail
  ::  Excerpt actual tang leaves without rendering an unbounded type tree.
  ::  Both pending work and visited nodes are bounded; oversized leaves skip.
  |=  trace=tang
  ^-  @t
  =/  pending=(list tank)  (scag 128 trace)
  =/  left=@ud  128
  =/  out=@t  'Native expression tang excerpt (formatting omitted; may be incomplete):'
  |-  ^-  @t
  ?:  |(=(0 left) =(~ pending))  out
  =/  node=tank  (snag 0 pending)
  =.  pending  (slag 1 pending)
  =.  left  (dec left)
  ?@  node  $(out (trace-append out node))
  ?:  ?=(%leaf -.node)
    $(out (trace-append out (crip (scag 2.049 p.node))))
  $(pending (scag 128 (weld (scag 128 q.node) pending)))
++  bounded-runtime
  ::  An old runtime ignores the new hint and returns 1. Refuse there before
  ::  evaluating any user expression; the finite probe never loops.
  ^-  ?
  =/  probe=tone
    (mink [0 [11 [%jinx [1 [%soft 1]]] [4 [1 0]]]] ~)
  ?.  ?=(%2 -.probe)  %.n
  ?~  trace.probe  %.n
  =([%mean 'evaluation-budget-exceeded'] i.trace.probe)
++  evaluate-detail
  ::  fuel is a native work budget in microseconds, not an instruction count
  ::  or authority deadline. No scry handler or effect interpreter is supplied.
  |=  [built=vase expression=@t fuel=@ud]
  ^-  (each [value=* packed=@ux] [reason=@tas detail=@t])
  ?.  &((gte fuel 1) (lte fuel 2.000.000) (lte (met 3 expression) 8.192))
    [%| %evaluation-budget-refused 'evaluation-budget-refused']
  ?.  bounded-runtime
    [%| %evaluation-runtime-unavailable 'The runtime cannot return a bounded evaluation timeout.']
  =/  budget=@dr  `@dr`(div (mul fuel ~s1) 1.000.000)
  =/  checked
    %-  mule
    |.  ^-  (each [value=* packed=@ux] [reason=@tas detail=@t])
    ::  One allowance covers compilation, evaluation and output packing.
    ~>  %jinx.[%soft budget]
    =/  compiled  (mule |.((~(mint ut p.built) %noun (ream expression))))
    ?:  ?=(%| -.compiled)  [%| %expression-compile-failed (trace-detail p.compiled)]
    =/  evaluated=tone  (mink [q.built q.p.compiled] ~)
    ?.  ?=(%0 -.evaluated)  [%| %evaluation-failed 'evaluation-failed']
    =/  packed=@ux  (jam product.evaluated)
    ?.  (lte (met 3 packed) 8.192)  [%| %evaluation-output-too-large 'evaluation-output-too-large']
    [%& [product.evaluated packed]]
  ?:  ?=(%| -.checked)  [%| %evaluation-failed (trace-detail p.checked)]
  p.checked
--
=/  proof
|%
++  tiny
  !>
  =>  base
  |%
  ++  yes  %.y
  ++  no  %.n
  --
++  unsupported
  ::  An older runtime must refuse before it evaluates the supplied expression.
  ?>  !bounded-runtime:tools
  =/  result  (evaluate-detail:tools tiny 'yes' 1.000.000)
  ?>  ?=(%| -.result)
  ?>  =(%evaluation-runtime-unavailable reason.p.result)
  [%native-coding-bounded-evaluation-unsupported-v1 %.y]
++  prove
  ?>  bounded-runtime:tools
  =/  before=vase  tiny
  =/  yes  (evaluate-detail:tools before 'yes' 1.000.000)
  ?>  ?=(%& -.yes)
  ?>  =([0 (jam 0)] p.yes)
  =/  no  (evaluate-detail:tools before 'no' 1.000.000)
  ?>  ?=(%& -.no)
  ?>  =([1 (jam 1)] p.no)
  =/  invalid  (evaluate-detail:tools before 'missing-arm' 1.000.000)
  ?>  ?=(%| -.invalid)
  ?>  =(%expression-compile-failed reason.p.invalid)
  =/  exited  (evaluate-detail:tools before '!!' 1.000.000)
  ?>  ?=(%| -.exited)
  ?>  =(%evaluation-failed reason.p.exited)
  =/  expired  (evaluate-detail:tools before 'yes' 1)
  ?>  ?=(%| -.expired)
  ?>  =(%evaluation-failed reason.p.expired)
  ?>  ?=(^ (find "evaluation-budget-exceeded" (trip detail.p.expired)))
  ::  A timeout must not consume the caller's value or poison its next check.
  ?>  =(before tiny)
  =/  again  (evaluate-detail:tools before 'yes' 1.000.000)
  ?>  =(yes again)
  =/  zero  (evaluate-detail:tools before 'yes' 0)
  ?>  ?=(%| -.zero)
  ?>  =(%evaluation-budget-refused reason.p.zero)
  =/  excess  (evaluate-detail:tools before 'yes' 2.000.001)
  ?>  ?=(%| -.excess)
  ?>  =(%evaluation-budget-refused reason.p.excess)
  [%native-coding-bounded-evaluation-proof-v1 %.y]
--
prove:proof
