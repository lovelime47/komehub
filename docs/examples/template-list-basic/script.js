(function () {
  'use strict';

  var runtime = window.KomehubTemplateRuntime;
  var starter = runtime.starters.list({
    container: '#comments',
    maxComments: 10,
    direction: 'append',
    cellTemplate: '#comment-template',
    styleId: 'sample-list-config-style',
    config: {
      maxComments: true,
      cssVars: {
        fontSize: ['--font-size', 'px'],
        accentColor: '--accent-color'
      },
      toggleCssVars: {
        showAvatar: ['--avatar-display', 'block', 'none'],
        rounded: ['--card-radius', '16px', '6px']
      },
      customCss: true
    }
  });

  var devPreviewScenarios = [
    {
      id: 'normal',
      label: '通常',
      comments: [
        {
          id: 'preview-normal',
          name: 'こめはぶ太郎',
          comment: '通常コメントの見た目です。セルの基本レイアウトを確認します。',
          commentHtml: '通常コメントの見た目です。セルの基本レイアウトを確認します。',
          profileImage: 'https://placehold.co/96x96/png',
          memberBadgeUrl: '',
          stickerImage: '',
          amount: 0,
          amountDisplay: '',
          isMember: false,
          isMembership: false,
          isMembershipGift: false,
          membershipHeader: '',
          giftCount: 0,
          isModerator: false,
          isOwner: false,
          isVerified: false,
          superchatTier: ''
        }
      ]
    },
    {
      id: 'superchat',
      label: 'スパチャ',
      comments: [
        {
          id: 'preview-superchat',
          name: 'スパチャ勢',
          comment: '色や金額表示、tier class の見た目を確認します。',
          commentHtml: '色や金額表示、tier class の見た目を確認します。',
          profileImage: 'https://placehold.co/96x96/f59e0b/ffffff?text=SC',
          memberBadgeUrl: '',
          stickerImage: '',
          amount: 5000,
          amountDisplay: '¥5,000',
          isMember: false,
          isMembership: false,
          isMembershipGift: false,
          membershipHeader: '',
          giftCount: 0,
          isModerator: false,
          isOwner: false,
          isVerified: false,
          superchatTier: 'red'
        }
      ]
    },
    {
      id: 'membership',
      label: 'メンバー継続',
      comments: [
        {
          id: 'preview-membership',
          name: 'メンバー継続さん',
          comment: '継続メッセージ本文です。',
          commentHtml: '継続メッセージ本文です。',
          profileImage: 'https://placehold.co/96x96/16a34a/ffffff?text=M',
          memberBadgeUrl: 'https://placehold.co/48x48/16a34a/ffffff?text=B',
          stickerImage: '',
          amount: 0,
          amountDisplay: '',
          isMember: true,
          isMembership: true,
          isMembershipGift: false,
          membershipHeader: 'メンバー歴 12 か月',
          giftCount: 0,
          isModerator: false,
          isOwner: false,
          isVerified: false,
          superchatTier: ''
        }
      ]
    },
    {
      id: 'gift',
      label: 'メンギフ',
      comments: [
        {
          id: 'preview-gift',
          name: 'ギフト隊長',
          comment: 'メンバーシップギフトを送りました。',
          commentHtml: 'メンバーシップギフトを送りました。',
          profileImage: 'https://placehold.co/96x96/7c3aed/ffffff?text=G',
          memberBadgeUrl: '',
          stickerImage: '',
          amount: 0,
          amountDisplay: '',
          isMember: false,
          isMembership: false,
          isMembershipGift: true,
          membershipHeader: 'メンバーシップギフト x 5',
          giftCount: 5,
          isModerator: false,
          isOwner: false,
          isVerified: false,
          superchatTier: ''
        }
      ]
    },
    {
      id: 'roles',
      label: '役職色',
      comments: [
        {
          id: 'preview-moderator',
          name: 'モデレーター',
          comment: '名前色の差分を確認します。',
          commentHtml: '名前色の差分を確認します。',
          profileImage: '',
          memberBadgeUrl: '',
          stickerImage: '',
          amount: 0,
          amountDisplay: '',
          isMember: false,
          isMembership: false,
          isMembershipGift: false,
          membershipHeader: '',
          giftCount: 0,
          isModerator: true,
          isOwner: false,
          isVerified: false,
          superchatTier: ''
        },
        {
          id: 'preview-owner',
          name: '配信者',
          comment: 'owner 色の差分も確認します。',
          commentHtml: 'owner 色の差分も確認します。',
          profileImage: '',
          memberBadgeUrl: '',
          stickerImage: '',
          amount: 0,
          amountDisplay: '',
          isMember: false,
          isMembership: false,
          isMembershipGift: false,
          membershipHeader: '',
          giftCount: 0,
          isModerator: false,
          isOwner: true,
          isVerified: false,
          superchatTier: ''
        }
      ]
    },
    {
      id: 'all',
      label: '全部',
      comments: []
    }
  ];
  devPreviewScenarios[5].comments = devPreviewScenarios
    .slice(0, 5)
    .reduce(function (items, scenario) {
      return items.concat(scenario.comments || []);
    }, []);

  runtime.createDevPreviewController({
    title: '通常テンプレ確認',
    scenarios: devPreviewScenarios,
    initialScenarioId: 'all',
    onSelect: function (scenario) {
      starter.applyConfig({
        fontSize: 24,
        accentColor: '#60a5fa',
        showAvatar: true
      });
      starter.renderComments(scenario.comments || [], { replace: true });
    }
  });
})();
