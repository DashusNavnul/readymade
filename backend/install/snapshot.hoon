::  Private owner snapshot, not a readiness or preservation verdict.
::  Caller binds arg to [expected=@p target=@tas revision=@ud].
=/  parameters  !<([expected=@p target=@tas revision=@ud] arg)
=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  &(=(expected.parameters our.b) =(our.b src.b))
=/  ship=@ta  (scot %p our.b)
=/  date=@ta  (scot %da now.b)
=/  ds=cone:clay  .^(cone:clay %cx /[ship]//[date]/domes)
=/  d=dome:clay  (~(got by ds) [our.b target.parameters])
?>  &(=(revision.parameters let.d) =(~ wic.d))
=/  root=tako:clay  (~(got by hit.d) revision.parameters)
=/  names=(map @tas @)  .^((map @tas @) %gf ship %$ date /$)
=/  apps
  %+  turn  ~(tap by names)
  |=  item=[name=@tas nonce=@]
  =/  egg=egg-any:gall  .^(egg-any:gall %gv ship name.item date /$)
  =/  owner=@tas  .^(@tas %gd ship name.item date /$)
  =/  live=?  .^(? %gu ship name.item date /$)
  ::  Retain the complete native carrier, including saved types/data and
  ::  subscription metadata. Do not coerce stopped or legacy carriers.
  [name.item nonce.item owner live egg]
=/  bindings=(list [binding=binding:eyre =duct action=action:eyre])
  .^((list [binding=binding:eyre =duct action=action:eyre]) %e ship %bindings date ~)
=/  snapshot
  [%readymade-private-install-snapshot-v1 now.b our.b target.parameters revision.parameters liv.d root apps ds bindings]
::  Bind observer identity to the same native event as the complete snapshot.
(pure:m !>([%readymade-observed-install-snapshot-v1 tid.b snapshot]))
