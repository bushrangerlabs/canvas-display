import{a as e}from"./rolldown-runtime-BYbx6iT9.js";import{t}from"./react-KD2OSrki.js";import{C as n,M as r,N as i,Y as a,Z as o,c as s,j as c,l,m as u,n as d,u as f}from"./createSimplePaletteValueFilter-CT34k9hp.js";import{t as p}from"./jsx-runtime-CuHXjfa2.js";var m=e(t(),1),h=0;function g(e){let[t,n]=m.useState(e),r=e||t;return m.useEffect(()=>{t??(h+=1,n(`mui-${h}`))},[t]),r}var _={...m}.useId;function v(e){if(_!==void 0){let t=_();return e??t}return g(e)}var y=v,b=l,x=s;function S(e,t){if(e==null)return{};var n={};for(var r in e)if({}.hasOwnProperty.call(e,r)){if(t.indexOf(r)!==-1)continue;n[r]=e[r]}return n}function C(e,t){return C=Object.setPrototypeOf?Object.setPrototypeOf.bind():function(e,t){return e.__proto__=t,e},C(e,t)}function w(e,t){e.prototype=Object.create(t.prototype),e.prototype.constructor=e,C(e,t)}var T=m.createContext(null);function E(e){if(e===void 0)throw ReferenceError(`this hasn't been initialised - super() hasn't been called`);return e}function D(e,t){var n=function(e){return t&&(0,m.isValidElement)(e)?t(e):e},r=Object.create(null);return e&&m.Children.map(e,function(e){return e}).forEach(function(e){r[e.key]=n(e)}),r}function O(e,t){e||={},t||={};function n(n){return n in t?t[n]:e[n]}var r=Object.create(null),i=[];for(var a in e)a in t?i.length&&(r[a]=i,i=[]):i.push(a);var o,s={};for(var c in t){if(r[c])for(o=0;o<r[c].length;o++){var l=r[c][o];s[r[c][o]]=n(l)}s[c]=n(c)}for(o=0;o<i.length;o++)s[i[o]]=n(i[o]);return s}function k(e,t,n){return n[t]==null?e.props[t]:n[t]}function ee(e,t){return D(e.children,function(n){return(0,m.cloneElement)(n,{onExited:t.bind(null,n),in:!0,appear:k(n,`appear`,e),enter:k(n,`enter`,e),exit:k(n,`exit`,e)})})}function te(e,t,n){var r=D(e.children),i=O(t,r);return Object.keys(i).forEach(function(a){var o=i[a];if((0,m.isValidElement)(o)){var s=a in t,c=a in r,l=t[a],u=(0,m.isValidElement)(l)&&!l.props.in;c&&(!s||u)?i[a]=(0,m.cloneElement)(o,{onExited:n.bind(null,o),in:!0,exit:k(o,`exit`,e),enter:k(o,`enter`,e)}):!c&&s&&!u?i[a]=(0,m.cloneElement)(o,{in:!1}):c&&s&&(0,m.isValidElement)(l)&&(i[a]=(0,m.cloneElement)(o,{onExited:n.bind(null,o),in:l.props.in,exit:k(o,`exit`,e),enter:k(o,`enter`,e)}))}}),i}var A=Object.values||function(e){return Object.keys(e).map(function(t){return e[t]})},j={component:`div`,childFactory:function(e){return e}},M=function(e){w(t,e);function t(t,n){var r=e.call(this,t,n)||this;return r.state={contextValue:{isMounting:!0},handleExited:r.handleExited.bind(E(r)),firstRender:!0},r}var n=t.prototype;return n.componentDidMount=function(){this.mounted=!0,this.setState({contextValue:{isMounting:!1}})},n.componentWillUnmount=function(){this.mounted=!1},t.getDerivedStateFromProps=function(e,t){var n=t.children,r=t.handleExited;return{children:t.firstRender?ee(e,r):te(e,n,r),firstRender:!1}},n.handleExited=function(e,t){var n=D(this.props.children);e.key in n||(e.props.onExited&&e.props.onExited(t),this.mounted&&this.setState(function(t){var n=o({},t.children);return delete n[e.key],{children:n}}))},n.render=function(){var e=this.props,t=e.component,n=e.childFactory,r=S(e,[`component`,`childFactory`]),i=this.state.contextValue,a=A(this.state.children).map(n);return delete r.appear,delete r.enter,delete r.exit,t===null?m.createElement(T.Provider,{value:i},a):m.createElement(T.Provider,{value:i},m.createElement(t,r,a))},t}(m.Component);M.propTypes={},M.defaultProps=j;var N={};function P(e,t){let n=m.useRef(N);return n.current===N&&(n.current=e(t)),n}var ne=[];function F(e){m.useEffect(e,ne)}var I=class e{static create(){return new e}currentId=null;start(e,t){this.clear(),this.currentId=setTimeout(()=>{this.currentId=null,t()},e)}clear=()=>{this.currentId!==null&&(clearTimeout(this.currentId),this.currentId=null)};disposeEffect=()=>this.clear};function L(){let e=P(I.create).current;return F(e.disposeEffect),e}function R(e){let{focusableWhenDisabled:t,disabled:n,composite:r=!1,tabIndex:i=0,isNativeButton:a}=e,o=r&&t!==!1,s=r&&t===!1;return m.useMemo(()=>{let e={onKeyDown(e){n&&t&&e.key!==`Tab`&&e.preventDefault()}};return r||(e.tabIndex=i,!a&&n&&(e.tabIndex=t?i:-1)),(a&&(t||o)||!a&&n)&&(e[`aria-disabled`]=n),a&&(!t||s)&&(e.disabled=n),e},[r,n,t,o,s,a,i])}var z={};function re(e){let{nativeButton:t,nativeButtonProp:n,internalNativeButton:r=t,allowInferredHostMismatch:i=!1,disabled:a,type:o,hasFormAction:s=!1,tabIndex:c=0,focusableWhenDisabled:l,stopEventPropagation:u=!1,onBeforeKeyDown:d,onBeforeKeyUp:f}=e,p=m.useRef(null),h=l===!0,g=R({focusableWhenDisabled:h,disabled:a,isNativeButton:t,tabIndex:c}),_=m.useCallback(()=>{let e=p.current;return e==null?t:e.tagName===`BUTTON`?!0:!!(e.tagName===`A`&&e.href)},[t]),v=m.useMemo(()=>{let e=h?{}:{tabIndex:a?-1:c};return t?(e.type=o===void 0&&!s?`button`:o,h||(e.disabled=a)):(e.role=`button`,!h&&a&&(e[`aria-disabled`]=a)),h?{...e,...g}:e},[a,h,g,s,t,c,o]);return{getButtonProps:m.useCallback((e=z)=>{let{onClick:t,onKeyDown:n,onKeyUp:r,...i}=e,o=e=>{if(u&&e.stopPropagation(),a){e.preventDefault();return}t?.(e)},s=e=>{if(h&&g.onKeyDown(e),!a&&(d?.(e),n?.(e),!(e.target!==e.currentTarget||_()))){if(e.key===` `){e.preventDefault();return}e.key===`Enter`&&(e.preventDefault(),e.currentTarget.click())}},c=e=>{a||(f?.(e),r?.(e),e.target===e.currentTarget&&!_()&&e.key===` `&&!e.defaultPrevented&&e.currentTarget.click())};return{...v,...i,onClick:o,onKeyDown:s,onKeyUp:c}},[v,a,h,g,_,d,f,u]),rootRef:p}}var B=class e{static create(){return new e}static use(){let t=P(e.create).current,[n,r]=m.useState(!1);return t.shouldMount=n,t.setShouldMount=r,m.useEffect(t.mountEffect,[n]),t}constructor(){this.ref={current:null},this.mounted=null,this.didMount=!1,this.shouldMount=!1,this.setShouldMount=null}mount(){return this.mounted||(this.mounted=V(),this.shouldMount=!0,this.setShouldMount(this.shouldMount)),this.mounted}mountEffect=()=>{this.shouldMount&&!this.didMount&&this.ref.current!==null&&(this.didMount=!0,this.mounted.resolve())};start(...e){this.mount().then(()=>this.ref.current?.start(...e))}stop(...e){this.mount().then(()=>this.ref.current?.stop(...e))}pulsate(...e){this.mount().then(()=>this.ref.current?.pulsate(...e))}};function ie(){return B.use()}function V(){let e,t,n=new Promise((n,r)=>{e=n,t=r});return n.resolve=e,n.reject=t,n}var H=p();function U(e){let{className:t,classes:n,pulsate:r=!1,rippleX:a,rippleY:o,rippleSize:s,in:c,onExited:l,timeout:u}=e,[d,f]=m.useState(!1),p=i(t,n.ripple,n.rippleVisible,r&&n.ripplePulsate),h={width:s,height:s,top:-(s/2)+o,left:-(s/2)+a},g=i(n.child,d&&n.childLeaving,r&&n.childPulsate);return!c&&!d&&f(!0),m.useEffect(()=>{if(!c&&l!=null){let e=setTimeout(l,u);return()=>{clearTimeout(e)}}},[l,c,u]),(0,H.jsx)(`span`,{className:p,style:h,children:(0,H.jsx)(`span`,{className:g})})}var W=c(`MuiTouchRipple`,[`root`,`ripple`,`rippleVisible`,`ripplePulsate`,`child`,`childLeaving`,`childPulsate`]),G=550,K=a`
  0% {
    transform: scale(0);
    opacity: 0.1;
  }

  100% {
    transform: scale(1);
    opacity: 0.3;
  }
`,q=a`
  0% {
    opacity: 1;
  }

  100% {
    opacity: 0;
  }
`,J=a`
  0% {
    transform: scale(1);
  }

  50% {
    transform: scale(0.92);
  }

  100% {
    transform: scale(1);
  }
`,Y=u(`span`,{name:`MuiTouchRipple`,slot:`Root`})({overflow:`hidden`,pointerEvents:`none`,position:`absolute`,zIndex:0,top:0,right:0,bottom:0,left:0,borderRadius:`inherit`}),X=u(U,{name:`MuiTouchRipple`,slot:`Ripple`})`
  opacity: 0;
  position: absolute;

  &.${W.rippleVisible} {
    opacity: 0.3;
    transform: scale(1);
    animation-name: ${K};
    animation-duration: ${G}ms;
    animation-timing-function: ${({theme:e})=>e.transitions.easing.easeInOut};
  }

  &.${W.ripplePulsate} {
    animation-duration: ${({theme:e})=>e.transitions.duration.shorter}ms;
  }

  & .${W.child} {
    opacity: 1;
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background-color: currentColor;
  }

  & .${W.childLeaving} {
    opacity: 0;
    animation-name: ${q};
    animation-duration: ${G}ms;
    animation-timing-function: ${({theme:e})=>e.transitions.easing.easeInOut};
  }

  & .${W.childPulsate} {
    position: absolute;
    /* @noflip */
    left: 0px;
    top: 0;
    animation-name: ${J};
    animation-duration: 2500ms;
    animation-timing-function: ${({theme:e})=>e.transitions.easing.easeInOut};
    animation-iteration-count: infinite;
    animation-delay: 200ms;
  }
`,ae=m.forwardRef(function(e,t){let{center:n=!1,classes:r={},className:a,...o}=f({props:e,name:`MuiTouchRipple`}),[s,c]=m.useState([]),l=m.useRef(0),u=m.useRef(null);m.useEffect(()=>{u.current&&=(u.current(),null)},[s]);let d=m.useRef(!1),p=L(),h=m.useRef(null),g=m.useRef(null),_=m.useCallback(e=>{let{pulsate:t,rippleX:n,rippleY:a,rippleSize:o,cb:s}=e;c(e=>[...e,(0,H.jsx)(X,{classes:{ripple:i(r.ripple,W.ripple),rippleVisible:i(r.rippleVisible,W.rippleVisible),ripplePulsate:i(r.ripplePulsate,W.ripplePulsate),child:i(r.child,W.child),childLeaving:i(r.childLeaving,W.childLeaving),childPulsate:i(r.childPulsate,W.childPulsate)},timeout:G,pulsate:t,rippleX:n,rippleY:a,rippleSize:o},l.current)]),l.current+=1,u.current=s},[r]),v=m.useCallback((e={},t={},r=()=>{})=>{let{pulsate:i=!1,center:a=n||t.pulsate,fakeElement:o=!1}=t;if(e?.type===`mousedown`&&d.current){d.current=!1;return}e?.type===`touchstart`&&(d.current=!0);let s=o?null:g.current,c=s?s.getBoundingClientRect():{width:0,height:0,left:0,top:0},l,u,f;if(a||e===void 0||e.clientX===0&&e.clientY===0||!e.clientX&&!e.touches)l=Math.round(c.width/2),u=Math.round(c.height/2);else{let{clientX:t,clientY:n}=e.touches&&e.touches.length>0?e.touches[0]:e;l=Math.round(t-c.left),u=Math.round(n-c.top)}if(a)f=Math.sqrt((2*c.width**2+c.height**2)/3),f%2==0&&(f+=1);else{let e=Math.max(Math.abs((s?s.clientWidth:0)-l),l)*2+2,t=Math.max(Math.abs((s?s.clientHeight:0)-u),u)*2+2;f=Math.sqrt(e**2+t**2)}e?.touches?h.current===null&&(h.current=()=>{_({pulsate:i,rippleX:l,rippleY:u,rippleSize:f,cb:r})},p.start(80,()=>{h.current&&=(h.current(),null)})):_({pulsate:i,rippleX:l,rippleY:u,rippleSize:f,cb:r})},[n,_,p]),y=m.useCallback(()=>{v({},{pulsate:!0})},[v]),b=m.useCallback((e,t)=>{if(p.clear(),e?.type===`touchend`&&h.current){h.current(),h.current=null,p.start(0,()=>{b(e,t)});return}h.current=null,c(e=>e.length>0?e.slice(1):e),u.current=t},[p]);return m.useImperativeHandle(t,()=>({pulsate:y,start:v,stop:b}),[y,v,b]),(0,H.jsx)(Y,{className:i(W.root,r.root,a),ref:g,...o,children:(0,H.jsx)(M,{component:null,exit:!0,children:s})})});function oe(e){return r(`MuiButtonBase`,e)}var se=c(`MuiButtonBase`,[`root`,`disabled`,`focusVisible`]),ce=e=>{let{disabled:t,focusVisible:r,focusVisibleClassName:i,suppressFocusVisible:a,classes:o}=e,s=n({root:[`root`,t&&`disabled`,r&&!a&&`focusVisible`]},oe,o);return r&&!a&&i&&(s.root+=` ${i}`),s},le=u(`button`,{name:`MuiButtonBase`,slot:`Root`})({display:`inline-flex`,alignItems:`center`,justifyContent:`center`,position:`relative`,boxSizing:`border-box`,WebkitTapHighlightColor:`transparent`,backgroundColor:`transparent`,outline:0,border:0,margin:0,borderRadius:0,padding:0,cursor:`pointer`,userSelect:`none`,verticalAlign:`middle`,MozAppearance:`none`,WebkitAppearance:`none`,textDecoration:`none`,color:`inherit`,"&::-moz-focus-inner":{borderStyle:`none`},[`&.${se.disabled}`]:{pointerEvents:`none`,cursor:`default`},"@media print":{colorAdjust:`exact`}}),Z=m.forwardRef(function(e,t){let n=f({props:e,name:`MuiButtonBase`}),{action:r,centerRipple:a=!1,children:o,className:s,component:c=`button`,disabled:l=!1,disableRipple:u=!1,disableTouchRipple:p=!1,focusRipple:h=!1,focusVisibleClassName:g,focusableWhenDisabled:_,suppressFocusVisible:v=!1,internalNativeButton:y,LinkComponent:S=`a`,nativeButton:C,onBlur:w,onClick:T,onContextMenu:E,onDragLeave:D,onFocus:O,onFocusVisible:k,onKeyDown:ee,onKeyUp:te,onMouseDown:A,onMouseLeave:j,onMouseUp:M,onTouchEnd:N,onTouchMove:P,onTouchStart:ne,tabIndex:F=0,TouchRippleProps:I,touchRippleRef:L,type:R,...z}=n,B=!!(z.href||z.to),V=!!z.formAction,U=c;U===`button`&&B&&(U=S);let W=typeof U==`string`?U===`button`:y??!1,G=C??W,K=ie(),q=x(K.ref,L),[J,Y]=m.useState(!1);(l||v)&&J&&Y(!1);let X=b(e=>{h&&!e.repeat&&J&&e.key===` `&&K.stop(e,()=>{K.start(e)})}),oe=b(e=>{h&&e.key===` `&&J&&!e.defaultPrevented&&K.stop(e,()=>{K.pulsate(e)})}),{getButtonProps:se,rootRef:Z}=re({nativeButton:G,nativeButtonProp:C,internalNativeButton:W,allowInferredHostMismatch:B||typeof U==`string`,disabled:l,type:R,hasFormAction:V,tabIndex:F,onBeforeKeyDown:X,onBeforeKeyUp:oe}),{onClick:ue,onKeyDown:de,onKeyUp:fe,...pe}=se({onClick:T,onKeyDown:ee,onKeyUp:te});m.useImperativeHandle(r,()=>({focusVisible:()=>{Y(!0),Z.current.focus()}}),[Z]);let me=K.shouldMount&&!u&&!l;m.useEffect(()=>{J&&h&&!u&&K.pulsate()},[u,h,J,K]);let he=Q(K,`start`,A,p),ge=Q(K,`stop`,E,p),_e=Q(K,`stop`,D,p),ve=Q(K,`stop`,M,p),ye=Q(K,`stop`,e=>{J&&e.preventDefault(),j&&j(e)},p),be=Q(K,`start`,ne,p),xe=Q(K,`stop`,N,p),Se=Q(K,`stop`,P,p),Ce=Q(K,`stop`,e=>{d(e.target)||Y(!1),w&&w(e)},!1),we=b(e=>{Z.current||=e.currentTarget,!v&&d(e.target)&&(Y(!0),k&&k(e)),O&&O(e)}),$={};B&&($.tabIndex=l?-1:F,l&&($[`aria-disabled`]=l),$.type=R);let Te=x(t,Z),Ee={...n,centerRipple:a,component:c,disabled:l,disableRipple:u,disableTouchRipple:p,focusRipple:h,suppressFocusVisible:v,tabIndex:F,focusVisible:J},De=ce(Ee);return(0,H.jsxs)(le,{as:U,className:i(De.root,s),ownerState:Ee,onBlur:Ce,onClick:ue,onContextMenu:ge,onFocus:we,onKeyDown:de,onKeyUp:fe,onMouseDown:he,onMouseLeave:ye,onMouseUp:ve,onDragLeave:_e,onTouchEnd:xe,onTouchMove:Se,onTouchStart:be,ref:Te,...B?$:pe,...z,children:[o,me?(0,H.jsx)(ae,{ref:q,center:a,...I}):null]})});function Q(e,t,n,r=!1){return b(i=>(n&&n(i),r||e[t](i),!0))}export{P as a,S as c,y as d,v as f,F as i,x as l,I as n,T as o,L as r,w as s,Z as t,b as u};