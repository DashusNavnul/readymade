::  Prepare a private inactive source-import baseline; never activate apps.
::  Bind arg: [expected=@p target=@tas action=?(%basis %isolate %clone %verify)
::             revision=@ud commit=@uv]
=/  p
  !<([expected=@p target=@tas action=?(%basis %isolate %clone %verify) revision=@ud commit=@uv] arg)
=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  &(=(expected.p our.b) =(our.b src.b) !=(%base target.p) !=(%$ target.p))
=/  ds=cone:clay  .^(cone:clay %cx /(scot %p our.b)//(scot %da now.b)/domes)
=/  base=dome:clay  (~(got by ds) [our.b %base])
=/  source=@uv  (~(got by hit.base) let.base)
?:  =(%basis action.p)
  (pure:m !>([%readymade-source-basis-v1 our.b let.base source]))
?>  &(=(revision.p let.base) =(commit.p source))
?:  =(%isolate action.p)
  ?>  !(~(has by ds) [our.b target.p])
  ;<  ~  bind:m
    (send-raw-card [%pass /readymade/source/isolate %arvo %c [%perm target.p / %rw `[%white ~] `[%white ~]]])
  (pure:m !>([%readymade-source-isolation-submitted-v1 target.p]))
=/  d=dome:clay  (~(got by ds) [our.b target.p])
?>  &(=(%dead liv.d) =(~ ren.d) =(~ wic.d))
=/  rules=[r=dict:clay w=dict:clay]
  .^([r=dict:clay w=dict:clay] %cp /(scot %p our.b)/(scot %tas target.p)/(scot %da now.b))
?>  &(=([%white ~ ~] rul.r.rules) =([%white ~ ~] rul.w.rules))
?:  =(%clone action.p)
  ?>  &(=(0 let.d) =(~ hit.d))
  ;<  ~  bind:m
    (send-raw-card [%pass /readymade/source/clone %arvo %c [%merg target.p our.b %base ud+revision.p %init]])
  (pure:m !>([%readymade-source-clone-submitted-v1 target.p source]))
?>  &(=(%verify action.p) =(1 let.d) =(source (~(got by hit.d) 1)))
=/  original=yaki:clay
  .^(yaki:clay %cs /(scot %p our.b)/base/(scot %da now.b)/yaki/(scot %uv source))
=/  actual=yaki:clay
  .^(yaki:clay %cs /(scot %p our.b)/(scot %tas target.p)/(scot %da now.b)/yaki/(scot %uv source))
?>  =(original actual)
(pure:m !>([%readymade-source-baseline-verified-v1 our.b target.p let.d source ~(wyt by q.actual)]))
