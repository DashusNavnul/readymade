::  Compile one billed app at the verified inactive revision; no activation.
::  Caller binds arg to [expected=@p target=@tas revision=@ud app=@tas].
=/  parameters  !<([expected=@p target=@tas revision=@ud app=@tas] arg)
=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  &(=(expected.parameters our.b) =(our.b src.b))
=/  ds=cone:clay  .^(cone:clay %cx /(scot %p our.b)//(scot %da now.b)/domes)
=/  d=dome:clay  (~(got by ds) [our.b target.parameters])
?>  &(=(revision.parameters let.d) =(%dead liv.d) =(~ wic.d))
=/  bill=(list @tas)
  .^((list @tas) %cx /(scot %p our.b)/[target.parameters]/(scot %ud revision.parameters)/desk/bill)
?>  (lien bill |=(name=@tas =(name app.parameters)))
;<  compiled=vase  bind:m
  (build-file-hard [[our.b target.parameters ud+revision.parameters] /app/[app.parameters]/hoon])
=/  checked=agent:gall  !<(agent:gall compiled)
?>  =(q.compiled checked)
(pure:m !>([%readymade-app-compiled-v1 our.b target.parameters revision.parameters app.parameters]))
