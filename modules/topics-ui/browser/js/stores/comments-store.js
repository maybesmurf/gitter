import Backbone from 'backbone';
import { getRealtimeClient } from './realtime-client';
import { getForumId } from './forum-store';
import LiveCollection from './live-collection';
import { BaseModel } from './base-model';
import dispatchOnChangeMixin from './mixins/dispatch-on-change';
import { subscribe } from '../../../shared/dispatcher';
import { SHOW_REPLY_COMMENTS } from '../../../shared/constants/topic';
import router from '../routers';
import { SUBMIT_NEW_COMMENT } from '../../../shared/constants/create-comment';
import { getCurrentUser } from './current-user-store';

export const CommentModel = BaseModel.extend({
  url() {
    return `/v1/forums/${getForumId()}/topics/${router.get('topicId')}/replies/${this.get('replyId')}/comments`;
  }
});

export const CommentsStore = LiveCollection.extend({
  model: CommentModel,
  client: getRealtimeClient(),
  urlTemplate: '/v1/forums/:forumId/topics/:topicId/replies/:replyId/comments',

  getContextModel(){
    return new Backbone.Model({
      forumId: getForumId(),
      topicId: router.get('topicId'),
      replyId: null,
    });
  },

  initialize(){
    subscribe(SHOW_REPLY_COMMENTS, this.onRequestNewComments, this);
    subscribe(SUBMIT_NEW_COMMENT, this.onSubmitNewComment, this);
    this.listenTo(router, 'change:topicId', this.onTopicIdUpdate, this);
  },

  getComments() {
    return this.toPOJO();
  },

  getCommentsByReplyId(id){
    if(id !== this.contextModel.get('replyId')) { return; }
    return this.toPOJO();
  },

  getActiveReplyId(){
    return this.contextModel.get('replyId');
  },

  onRequestNewComments({replyId}){
    this.contextModel.set('replyId', replyId);
  },

  onTopicIdUpdate(router, topicId){
    this.contextModel.set('topicId', topicId);
  },

  onSubmitNewComment({ replyId, text }) {
    this.create({
      replyId: replyId,
      text: text,
      user: getCurrentUser(),
    })
  },

});

dispatchOnChangeMixin(CommentsStore);

let store;

export function getCommentsStore(){
  if(!store) { store = new CommentsStore(); }
  return store;
}
