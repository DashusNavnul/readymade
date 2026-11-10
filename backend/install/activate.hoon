::  Ten-app installation policy v2, including explicit project activity.
::  Guarded native activation; prepare first with submit=%.n.
::  Requires all compilation/source proofs for this exact immutable root.
=/  parameters  !<([expected=@p target=@tas revision=@ud root=@ux submit=?] arg)
=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  &(=(expected.parameters our.b) =(our.b src.b))
=/  ship=@ta  (scot %p our.b)
=/  date=@ta  (scot %da now.b)
=/  ds=cone:clay  .^(cone:clay %cx /[ship]//[date]/domes)
=/  d=dome:clay  (~(got by ds) [our.b target.parameters])
?>  &(=(revision.parameters let.d) =(~ wic.d))
=/  root=tako:clay  (~(got by hit.d) revision.parameters)
?>  &(=(root.parameters root) =(%dead liv.d))
=/  override-present=?
  =/  auxiliaries=(list @tas)
    ~[%glass-desktop-build %host-law %host-viki %hot-viki]
  %+  lien  auxiliaries
  |=  auxiliary=@tas
  (~(has by ds) [our.b auxiliary])
?>  !override-present
=/  names=(map @tas @)  .^((map @tas @) %gf ship %$ date /$)
=/  wanted=(list @tas)
  ~[%graf %cantrip %viki %cli-inference %multiplayer-runtime %readymade-collab %native-coding-source-import %pataphor-native-console %pataphor-page %readymade-editing]
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
  ~[/graf /apps/qpc-ark /apps/pataphor-cli /apps/readymade-collab /apps/pataphor-native /apps/pataphor /apps/readymade-editing]
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
=/  snapshot
  [%readymade-observed-install-snapshot-v1 tid.b [%readymade-private-install-snapshot-v1 now.b our.b target.parameters revision.parameters liv.d root apps ds bindings]]
?.  submit.parameters
  (pure:m !>([%readymade-activation-prepared-v2 snapshot]))
;<  ~  bind:m  (send-raw-card [%pass /readymade/install %arvo %c [%zest target.parameters %live]])
(pure:m !>([%readymade-activation-submitted-v2 snapshot]))
