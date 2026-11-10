::  Ten-app installation policy v2, including explicit project activity.
::  Fresh backend structure check, not saved-state or coding acceptance.
=/  parameters  !<([expected=@p target=@tas revision=@ud root=@ux existing-apps=@ud] arg)
=/  m  (strand ,vase)
;<  b=bowl  bind:m  get-bowl
?>  &(=(expected.parameters our.b) =(our.b src.b))
=/  ship=@ta  (scot %p our.b)
=/  date=@ta  (scot %da now.b)
=/  ds=cone:clay  .^(cone:clay %cx /[ship]//[date]/domes)
=/  d=dome:clay  (~(got by ds) [our.b target.parameters])
?>  &(=(revision.parameters let.d) =(%live liv.d) =(~ wic.d) =(~ ren.d))
?>  =(root.parameters (~(got by hit.d) revision.parameters))
?>  =(*dome:clay (~(got by ds) [our.b %host-viki]))
?>  =(*dome:clay (~(got by ds) [our.b %hot-viki]))
=/  names=(map @tas @)  .^((map @tas @) %gf ship %$ date /$)
?>  =((add 10 existing-apps.parameters) ~(wyt by names))
=/  wanted=(list @tas)
  ~[%graf %cantrip %viki %cli-inference %multiplayer-runtime %readymade-collab %native-coding-source-import %pataphor-native-console %pataphor-page %readymade-editing]
?>  (levy wanted |=(name=@tas &((~(has by names) name) =(target.parameters .^(@tas %gd ship name date /$)))))
?>  (levy ~(tap by names) |=([name=@tas nonce=@] .^(? %gu ship name date /$)))
(pure:m !>([%readymade-backend-post-install-v2 our.b now.b target.parameters let.d root.parameters ~(wyt by names)]))
