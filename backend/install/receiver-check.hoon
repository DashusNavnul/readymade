::  Ten-app installation policy v2, including explicit project activity.
::  Read-only Khan strand. Caller binds arg to !>([expected=@p target=@tas]).
=/  parameters  !<([expected=@p target=@tas] arg)
=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  &(=(expected.parameters our.b) =(our.b src.b))
=/  ship=@ta  (scot %p our.b)
=/  date=@ta  (scot %da now.b)
=/  ds=cone:clay  .^(cone:clay %cx /[ship]//[date]/domes)
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
=/  desk-present=?  (~(has by ds) [our.b target.parameters])
=/  override-present=?
  =/  auxiliaries=(list @tas)
    ~[%glass-desktop-build %host-law %host-viki %hot-viki]
  %+  lien  auxiliaries
  |=  auxiliary=@tas
  (~(has by ds) [our.b auxiliary])
=/  eligible=?  &(kernel bounded !desk-present !override-present =(~ collisions) =(~ conflicts))
(pure:m !>([%readymade-receiver-check-v2 our.b target.parameters eligible kernel bounded desk-present override-present collisions conflicts]))
