::  One owner-authorized staging operation. Caller binds arg to this shape:
::  [expected=@p target=@tas action=?(%observe %create %mount %commit) revision=@ud]
::  Observe is read-only and requires revision=0; it reports current state.
=/  parameters
  !<([expected=@p target=@tas action=?(%observe %create %mount %commit) revision=@ud] arg)
=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  &(=(expected.parameters our.b) =(our.b src.b))
=/  ds=cone:clay  .^(cone:clay %cx /(scot %p our.b)//(scot %da now.b)/domes)
?:  =(%observe action.parameters)
  ?>  =(0 revision.parameters)
  =/  found  (~(get by ds) [our.b target.parameters])
  ?~  found
    (pure:m !>([%readymade-stage-observed-v1 our.b target.parameters ~]))
  =/  root=(unit tako:clay)  (~(get by hit.u.found) let.u.found)
  (pure:m !>([%readymade-stage-observed-v1 our.b target.parameters [~ let.u.found liv.u.found =(~ wic.u.found) root]]))
?:  =(%create action.parameters)
  ?>  &(=(0 revision.parameters) !(~(has by ds) [our.b target.parameters]))
  =/  base=dome:clay  (~(got by ds) [our.b %base])
  ?>  =((cord-to-waft:clay '[%zuse 408]') .^(waft:clay %cx /(scot %p our.b)/base/(scot %da now.b)/sys/kelvin))
  ;<  ~  bind:m
    (send-raw-card [%pass /readymade/stage/create %arvo %c [%merg target.parameters our.b %base ud+let.base %init]])
  (pure:m !>([%readymade-stage-submitted-v1 our.b target.parameters %create let.base]))
=/  d=dome:clay  (~(got by ds) [our.b target.parameters])
?>  &(=(revision.parameters let.d) =(%dead liv.d) =(~ wic.d))
?:  =(%mount action.parameters)
  ;<  ~  bind:m
    (send-raw-card [%pass /readymade/stage/mount %arvo %c [%mont target.parameters [[our.b target.parameters da+now.b] /]]])
  (pure:m !>([%readymade-stage-submitted-v1 our.b target.parameters %mount let.d]))
?>  =(%commit action.parameters)
;<  ~  bind:m
  (send-raw-card [%pass /readymade/stage/commit %arvo %c [%dirk target.parameters]])
(pure:m !>([%readymade-stage-submitted-v1 our.b target.parameters %commit let.d]))
