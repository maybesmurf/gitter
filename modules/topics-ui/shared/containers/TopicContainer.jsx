import React, {PropTypes, createClass} from 'react';
import {dispatch} from '../dispatcher';

import TopicHeader from './components/topic/topic-header.jsx';
import TopicBody from './components/topic/topic-body.jsx';
import SearchHeader from './components/search/search-header.jsx';
import TopicReplyEditor from './components/topic/topic-reply-editor.jsx';
import TopicReplyListHeader from './components/topic/topic-reply-list-header.jsx';
import TopicReplyList from './components/topic/topic-reply-list.jsx';
import TopicReplyListItem from './components/topic/topic-reply-list-item.jsx';

import updateReplyBody from '../action-creators/create-reply/body-update';
import submitNewReply from '../action-creators/create-reply/submit-new-reply';
import updateCommentBody from '../action-creators/create-comment/body-update';
import submitNewComment from '../action-creators/create-comment/submit-new-comment';
import showReplyComments from '../action-creators/topic/show-reply-comments';
import updateReply from '../action-creators/topic/update-reply';
import cancelUpdateReply from '../action-creators/topic/cancel-update-reply';
import saveUpdatedReply from '../action-creators/topic/save-update-reply';
import updateComment from '../action-creators/topic/update-comment.js';
import updateCancelComment from '../action-creators/topic/update-cancel-comment.js';
import updateSaveComment from '../action-creators/topic/update-save-comment.js';

const TopicContainer = createClass({

  displayName: 'TopicContainer',
  propTypes: {

    topicId: PropTypes.string.isRequired,
    groupName: PropTypes.string.isRequired,

    topicsStore: PropTypes.shape({
      getById: PropTypes.func.isRequired,
    }).isRequired,

    repliesStore: PropTypes.shape({
      getReplies: PropTypes.func.isRequired
    }).isRequired,

    commentsStore: PropTypes.shape({
      getComments: PropTypes.func.isRequired,
    }),

    categoryStore: PropTypes.shape({
      getCategories: PropTypes.func.isRequired,
    }).isRequired,

    tagStore: PropTypes.shape({
      getTags: PropTypes.func.isRequired,
      getTagsByLabel: PropTypes.func.isRequired,
    }).isRequired,

    currentUserStore: PropTypes.shape({
      getCurrentUser: PropTypes.func.isRequired
    }).isRequired,

    newReplyStore: PropTypes.shape({
      get: PropTypes.func.isRequired,
    }),

    newCommentStore: PropTypes.shape({
      get: PropTypes.func.isRequired,
    }),

  },

  componentDidMount(){
    const {repliesStore, newReplyStore, commentsStore, newCommentStore} = this.props;
    repliesStore.onChange(this.updateReplies, this);
    commentsStore.onChange(this.updateComments, this);
    newCommentStore.onChange(this.updateNewComment, this);

    newReplyStore.on('change:text', this.updateNewReplyContent, this);
  },

  componentWillUnmount(){
    const {repliesStore, newReplyStore, commentsStore, newCommentStore} = this.props;
    repliesStore.removeListeners(this.updateReplies, this);
    commentsStore.removeListeners(this.updateComments, this);
    newCommentStore.removeListeners(this.updateNewComment, this);

    newReplyStore.off('change:text', this.updateNewReplyContent, this);
  },

  getInitialState(){
    return {
      newReplyContent: '',
    };
  },


  render(){

    const { topicId, topicsStore, groupName, categoryStore, currentUserStore, tagStore} = this.props;
    const {newReplyContent} = this.state;
    const topic = topicsStore.getById(topicId)
    const currentUser = currentUserStore.getCurrentUser();
    const topicCategory = topic.category;
    const category = categoryStore.getById(topicCategory.id);

    //TODO remove
    //This is here because sometimes you can get un-parsed tags
    //we need to hydrate the client stores with the raw SS data
    //not the parsed data which will avoid nesting and inconsistent data
    const tagValues = topic.tags.map(function(t){
      return t.label ? t.label : t;
    });
    const tags = tagStore.getTagsByLabel(tagValues);

    const parsedReplies = this.getParsedReplies();

    return (
      <main>
        <SearchHeader groupName={groupName}/>
        <article>
          <TopicHeader
            topic={topic}
            category={category}
            groupName={groupName}
            tags={tags}/>
          <TopicBody topic={topic} />
        </article>
        <TopicReplyListHeader replies={parsedReplies}/>
        <TopicReplyList>
          {parsedReplies.map(this.getReplyListItem)}
        </TopicReplyList>
        <TopicReplyEditor
          user={currentUser}
          value={newReplyContent}
          onChange={this.onNewReplyEditorUpdate}
          onSubmit={this.onNewReplyEditorSubmit}/>
      </main>
    );
  },


  getReplyListItem(reply, index){
    const {newCommentStore, currentUserStore} = this.props;
    const currentUser = currentUserStore.getCurrentUser();
    return (
      <TopicReplyListItem
        reply={reply}
        key={`topic-reply-list-item-${reply.id}-${index}`}
        currentUser={currentUser}
        newCommentContent={newCommentStore.get('text')}
        onCommentsClicked={this.onReplyCommentsClicked}
        onNewCommentUpdate={this.onNewCommentUpdate}
        submitNewComment={this.submitNewComment}
        onReplyEditUpdate={this.onReplyEditUpdate}
        onReplyEditCancel={this.onReplyEditCancel}
        onReplyEditSaved={this.onReplyEditSaved}
        onCommentEditUpdate={this.onReplyEditUpdate}
        onCommentEditCancel={this.onCommentEditCancel}
        onCommentEditSave={this.onCommentEditSave}/>
    );
  },

  onNewReplyEditorUpdate(val){
    dispatch(updateReplyBody(val));
  },

  onNewReplyEditorSubmit(){
    const {newReplyStore} = this.props;
    dispatch(submitNewReply(newReplyStore.get('text')));
    //Clear input
    newReplyStore.clear();
    this.setState((state) => Object.assign(state, {
      newReplyContent: '',
    }));
  },

  updateNewReplyContent(){
    const {newReplyStore} = this.props;
    const newReplyContent = newReplyStore.get('text');
    this.setState((state) => Object.assign(state, {
      newReplyContent: newReplyContent,
    }));
  },

  updateReplies(){
    const {repliesStore} = this.props;
    this.setState((state) => Object.assign(state, {
      replies: repliesStore.getReplies(),
      newReplyContent: '',
    }));
  },

  updateComments(){
    this.forceUpdate();
  },

  getParsedReplies(){
    const {repliesStore, commentsStore} = this.props;
    return repliesStore.getReplies().map((reply) => Object.assign({}, reply, {
      comments: commentsStore.getCommentsByReplyId(reply.id),
      isCommenting: commentsStore.getActiveReplyId() === reply.id,
    }))
  },

  onReplyCommentsClicked(replyId){
    dispatch(showReplyComments(replyId));
  },

  onNewCommentUpdate(replyId, val) {
    dispatch(updateCommentBody(replyId, val));
  },

  submitNewComment(){
    const {newCommentStore} = this.props;
    dispatch(submitNewComment(
      newCommentStore.get('replyId'),
      newCommentStore.get('text')
    ));
  },

  updateNewComment(){ this.forceUpdate(); },

  onReplyEditUpdate(replyId, value){
    dispatch(updateReply(replyId, value));
  },

  onReplyEditCancel(replyId) {
    dispatch(cancelUpdateReply(replyId));
  },

  onReplyEditSaved(replyId){
    dispatch(saveUpdatedReply(replyId));
  },

  onCommentEditUpdate(commentId, value){
    dispatch(updateComment(commentId, value));
  },

  onCommentEditCancel(commentId) {
    dispatch(updateCancelComment(commentId));
  },

  onCommentEditSave(commentId){
    dispatch(updateSaveComment(commentId));
  }

});

export default TopicContainer;
