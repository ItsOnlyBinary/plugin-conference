kiwi.plugin('conferencePlugin', function(kiwi, log) {
  let api = null;
  let jitsiDomain = kiwi.state.setting('conference.server') || 'meet.jit.si'
  let jitsiApiUrl = kiwi.state.setting('conference.jitsiApiUrl') || 'https://' + jitsiDomain + '/external_api.min.js'

  // Load any jitsi UI config settings
  let interfaceConfigOverwriteFromConfig = kiwi.state.setting('conference.interfaceConfigOverwrite') || {}
  let interfaceConfigOverwrite = {
    "SHOW_JITSI_WATERMARK": false,
    "SHOW_WATERMARK_FOR_GUESTS": false,
    "TOOLBAR_BUTTONS": [
      "microphone", "camera", "fullscreen", "fodeviceselection", "hangup",
      "settings", "videoquality", "filmstrip",
      "stats", "shortcuts"
    ]
  }
  Object.keys(interfaceConfigOverwriteFromConfig).forEach(key => {
    interfaceConfigOverwrite[key] = interfaceConfigOverwriteFromConfig[key];
  });

  // Load any jitsi general config settings
  let configOverwriteFromConfig = kiwi.state.setting('conference.configOverwrite') || {}
  let configOverwrite = {
    "startWithVideoMuted": true,
    "startWithAudioMuted": true
  }
  Object.keys(configOverwriteFromConfig).forEach(key => {
    configOverwrite[key] = configOverwriteFromConfig[key];
  });
  
  
  // Add the call button to the channel+query headers
  const conferencingTool = document.createElement('div');
  conferencingTool.style.marginLeft = '10px';
  conferencingTool.style.cursor = 'pointer';
  conferencingTool.innerHTML = '<i aria-hidden="true" class="fa fa-phone"></i>';
  kiwi.addUi('header_channel', conferencingTool);
  kiwi.addUi('header_query', conferencingTool);
  conferencingTool.onclick = function(e){
    e.preventDefault();
    if(api){
      hideCams();
    }else{
      showCams();
    }
  }

  // The component that gets shown in the messagelist when somebody joins a conference call
  const joinCallMessageComponent = kiwi.Vue.extend({
    template:`<div style="width:100%; padding: 20px; background: #ccc; text-align: center; color: #000; font-size: 2em;">
      <i aria-hidden="true" class="fa fa-phone"></i>
      {{caption}}
      <button @click="showCams()">Join now!</button>
    </div>`,
    props: [
      'message',
      'buffer',
    ],
    data() {
      return { caption: '' };
    },
    methods: {
      showCams: showCams,
    },
  });

  kiwi.on('message.new', function (newMessage, buffer) {
    let showComponent = false;
    let message = '';
    let nick = '';
    if (newMessage.tags && typeof newMessage.tags['+kiwiirc.com/conference'] !== 'undefined' && newMessage.tags['+kiwiirc.com/conference']) {
      nick = newMessage.nick;
      console.log(buffer);
      if (buffer.isChannel()) {
        message = 'has joined the conference.';
        // if(newMessage.message === message) return;
        showComponent = true;
      } else {
        message = 'is inviting you to a private call.';
        // if(e.message === message) return;
        showComponent = true;
      }
      if (showComponent) {
        newMessage.template = joinCallMessageComponent.extend({
          data() {
            return { caption: nick + ' ' +  message };
          }
        });
      }
    }
  });
  
  function showCams(){
    kiwi.emit('mediaviewer.show', { iframe: true, url: 'about:blank' });
    // Give some time for the mediaviewer to show up in the DOM
    setTimeout(loadJitsi, 10);
  }

  function loadJitsi() {
    let iframe = prepareJitsiIframe();
    let innerDoc = iframe.contentDocument || iframe.contentWindow.document;
    let jitsiBody = innerDoc.getElementsByTagName('body')[0];
    let innerHead = innerDoc.getElementsByTagName('head')[0];
    
    let network = window.kiwi.state.getActiveNetwork();
    let buffer = window.kiwi.state.getActiveBuffer();

    let roomName;
    let m = null;
    if(!network.isChannelName(buffer.name)){ // cam is being invoked in PM, not a channel
      let nicks = [];
      nicks.push(network.nick);
      nicks.push(buffer.name);
      nicks.sort();
      nicks[0] = 'query-' + nicks[0] + '#';
      roomName = nicks.join('');
      // buffer.say('is inviting you to a private call.', {type: 'action'});
      m = new network.ircClient.Message('PRIVMSG', buffer.name, '* ' + network.nick + ' is inviting you to a private call.');
    }else{
      roomName = buffer.name;
      // buffer.say('has joined the conference.', {type: 'action'});
      m = new network.ircClient.Message('PRIVMSG', buffer.name, '* ' + network.nick + ' has joined the conference.');
    }

    m.tags['+kiwiirc.com/conference'] = true;
    network.ircClient.raw(m);

    // Get the JWT token from the network
    kiwi.once('irc.raw.EXTJWT', function(command, message) {
      let token = message.params[1]
      let options = {
          roomName: encodeRoomName(network.connection.server, roomName),
          displayName: buffer.name,
          parentNode: jitsiBody,
          interfaceConfigOverwrite,
          configOverwrite
      }

      // Load the jitsi script into the mediaviewer iframe
      let jitsiAPIScript = innerDoc.createElement("script");
      jitsiAPIScript.setAttribute("type", "text/javascript");
      jitsiAPIScript.setAttribute("src", jitsiApiUrl);
      jitsiAPIScript.addEventListener("load", function(event){
        if(event.target.nodeName === "SCRIPT"){
          jitsiBody.innerHTML="";
          options.jwt = token;
          options.noSsl = false;
          api = new iframe.contentWindow.JitsiMeetExternalAPI(jitsiDomain, options);
          api.executeCommand('displayName', network.nick);
          api.on('videoConferenceLeft', () => {
            hideCams();
          });
        }
      });
      innerHead.appendChild(jitsiAPIScript);
    });

    network.ircClient.raw('EXTJWT ' + roomName);
  }

  function prepareJitsiIframe() {
    let iframe = document.querySelector('.kiwi-mediaviewer iframe');
    let mediaviewer = document.querySelector('.kiwi-mediaviewer');
    let innerDoc = iframe.contentDocument || iframe.contentWindow.document;
    let jitsiDiv = innerDoc.getElementsByTagName('body')[0];
    let innerHead = innerDoc.getElementsByTagName('head')[0];

    jitsiDiv.style.margin = 0;
    iframe.style.width = '100%';
    mediaviewer.style.height = '45%';
    iframe.style.height = '100%';

    return iframe;
  }

  function hideCams(){
    api.dispose();
    api = false;
    kiwi.emit('mediaviewer.hide');
  }

  // To cover special characters in channel and query names, encode the complete name
  // into hex characters. The Jitsi server will decode this server-side
  function encodeRoomName(serverAddr, roomName) {
    let room = serverAddr + '/' + roomName;
    return room.split('').map(c => c.charCodeAt(0).toString(16)).join('');
  }
});
