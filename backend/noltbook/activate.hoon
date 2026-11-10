::  Guarded native activation; prepare first with submit=%.n.
::  Requires all compilation/source proofs for this exact immutable root.
=/  parameters  !<([expected=@p target=@tas revision=@ud root=@ux existing-apps=@ud submit=?] arg)
=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  &(=(expected.parameters our.b) =(our.b src.b))
=/  ship=@ta  (scot %p our.b)
=/  date=@ta  (scot %da now.b)
=/  ds=cone:clay  .^(cone:clay %cx /[ship]//[date]/domes)
=/  d=dome:clay  (~(got by ds) [our.b target.parameters])
?>  &(=(revision.parameters let.d) =(~ wic.d))
=/  root=tako:clay  (~(got by hit.d) revision.parameters)
?>  &(=(root.parameters root) =(%dead liv.d) =(~ ren.d))
=/  override-present=?
  =/  auxiliaries=(list @tas)
    ~[%glass-desktop-build %host-law %host-viki %hot-viki]
  %+  lien  auxiliaries
  |=  auxiliary=@tas
  =/  found  (~(get by ds) [our.b auxiliary])
  ?~  found  %.n
  !=(u.found *dome:clay)
?>  !override-present
=/  names=(map @tas @)  .^((map @tas @) %gf ship %$ date /$)
=/  wanted=(list @tas)
  ~[%noltbook %noltbook-calls]
=/  rosters
  %+  turn  ~(tap by ds)
  |=  [key=[owner=@p desk=@tas] value=dome:clay]
  ?:  !=(owner.key our.b)  [desk.key *(set [@tas ?])]
  [desk.key .^((set [@tas ?]) %ge /[ship]/[desk.key]/[date]/$)]
=/  collisions
  %-  zing
  %+  turn  rosters
  |=  [desk=@tas roster=(set [name=@tas live=?])]
  %+  turn
    %+  skim  ~(tap in roster)
    |=  [name=@tas live=?]
    (lien wanted |=(app=@tas =(app name)))
  |=  [name=@tas live=?]
  [name desk live]
?>  =(~ collisions)
=/  revision=@ta  (scot %ud revision.parameters)
?>  =(wanted .^((list @tas) %cx /[ship]/[target.parameters]/[revision]/desk/bill))
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
=/  routes=(list path)
  ~[/apps/noltbook]
=/  conflicts
  %+  skim  bindings
  |=  old=[binding=binding:eyre =duct action=action:eyre]
  ?:  &(=(action.old [%app %docket]) |(=(path.binding.old /) =(path.binding.old /apps)))  %.n
  %+  lien  routes
  |=  new=path
  =/  old-path=path  path.binding.old
  |(=(old-path (scag (lent old-path) new)) =(new (scag (lent new) old-path)))
=/  kernel=?
  =((cord-to-waft:clay '[%zuse 408]') .^(waft:clay %cx /[ship]/base/[date]/sys/kelvin))
=/  probe=tone  (mink [0 [11 [%jinx [1 [%soft 1]]] [4 [1 0]]]] ~)
=/  bounded=?
  ?.  ?=(%2 -.probe)  %.n
  ?~  trace.probe  %.n
  =([%mean 'evaluation-budget-exceeded'] i.trace.probe)
?>  &(kernel bounded =(~ conflicts))
?>  !(~(has by ds) [our.b %noltbook-data])
?>  =(existing-apps.parameters (lent apps))
?>  (levy apps |=([name=@tas nonce=@ owner=@tas live=? egg=egg-any:gall] live))
=/  snapshot
  [%readymade-private-install-snapshot-v1 now.b our.b target.parameters revision.parameters liv.d root apps ds bindings]
?.  submit.parameters
  (pure:m !>([%readymade-activation-prepared-v1 %readymade-observed-install-snapshot-v1 tid.b snapshot]))
;<  ~  bind:m  (send-raw-card [%pass /readymade/install %arvo %c [%zest target.parameters %live]])
(pure:m !>([%noltbook-activation-submitted-v1 our.b target.parameters revision.parameters root (lent apps) (shax (jam names))]))
